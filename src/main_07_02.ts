import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  END,
  MemorySaver,
  MessagesValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { createAgent, tool } from "langchain";
import { config } from "dotenv";
import { load } from "cheerio";
import { z } from "zod";

import { getWeatherForecast } from "./open_meteo.js";
import { bnbAvailabilityTool, hotelAvailabilityTool } from "./hotel_booking.js";


// =============================================================================
// Load environment variables
// =============================================================================

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");

config({ path: envPath });


// =============================================================================
// 1. Destination list and fallback knowledge base
// =============================================================================

// WikiVoyage slugs used when building the vector store.
const destinations = [
  "Cornwall",
  "North_Cornwall",
  "South_Cornwall",
  "West_Cornwall",
];

const fallbackTravelKnowledge = [
  `Cornwall is a county in southwest England known for dramatic cliffs, sandy beaches, fishing harbours, and a mild Atlantic climate. Popular centres include Newquay, Falmouth, St Ives, Penzance, Padstow, and Bude.`,
  `North Cornwall includes Padstow, Newquay, and the Camel Estuary. It is known for surfing, coastal walks, and access to the Camel Trail. The area has strong family-friendly beaches and a lively harbour scene.`,
  `South Cornwall includes Fowey, Looe, St Austell, Mevagissey, and the Lizard Peninsula. It mixes working harbours, quaint villages, and scenic coastal paths.`,
  `West Cornwall includes Penzance, St Ives, Lands End, and Hayle. This region is known for dramatic sea views, galleries, fishing communities, and weather that is often milder than the rest of the UK.`,
  `Accommodation in Cornwall ranges from seaside hotels to guesthouses and BnBs. Budget-friendly options are common in Newquay, Hayle, and St Austell, while St Ives and Padstow often have higher nightly prices.`,
];


// =============================================================================
// 2. Graph state schema
// =============================================================================

// The workflow carries two pieces of state:
//   • messages – the full conversation history (LangGraph appends automatically)
//   • route    – which sub-agent the router has chosen for this turn
const workflowState = new StateSchema({ //A
  messages: MessagesValue,
  route: z
    .enum(["travel_info_agent", "accommodation_booking_agent", "guardrail_refusal"])
    .default("guardrail_refusal"),
});

type WorkflowState = typeof workflowState.State;

//A StateSchema defines the shape of the state object that flows through all graph nodes


// =============================================================================
// 3. Refusal message (shown when the guardrail blocks a query)
// =============================================================================

const REFUSAL_MESSAGE =
  "Sorry, I can only help with travel questions focused on Cornwall, England, " +
  "such as destinations, attractions, hotels, BnBs, prices, availability, and local weather.";

// =============================================================================
// 4. Build the travel-information vector store (knowledge base)
// =============================================================================

/**
 * Download a single WikiVoyage page, extract its main content,
 * and return it as a LangChain Document. Retries up to three times on failure.
 */
async function fetchTravelPage(source: string): Promise<Document> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(source, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
          Accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const $ = load(html);
      const pageContent = $("#mw-content-text").text().trim();
      if (!pageContent) {
        throw new Error("No travel content found on the page");
      }

      // Wrap plain text in a LangChain Document so it can be split and embedded
      return new Document({ pageContent, metadata: { source } });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown network error";
      if (attempt === maxAttempts) {
        throw new Error(
          `Unable to download travel page ${source} after ${maxAttempts} attempts: ${message}`,
          { cause: error },
        );
      }

      console.warn(
        `Travel page request failed (attempt ${attempt}/${maxAttempts}): ${source} — ${message}. Retrying...`,
      );

      // Wait for a delay before retrying (attempt 1 = 1s, attempt 2 = 2s, etc.)
      // resolveRetry resolves the Promise once setTimeout completes.
      await new Promise((resolveRetry) =>
        setTimeout(resolveRetry, attempt * 1_000),
      );
    }
  }

  throw new Error(`Unable to download travel page ${source}`);
}


/**
 * Fetch all destination pages, split them into chunks, embed them, and
 * return a retriever backed by an in-memory vector store.
 */
async function buildTravelRetriever(): Promise<
  Awaited<ReturnType<MemoryVectorStore["asRetriever"]>>
> {
  const pages: Document[] = [];
  const fetchErrors: string[] = [];

  // Try every destination; collect errors instead of crashing immediately.
  for (const destination of destinations) {
    try {
      pages.push(
        await fetchTravelPage(`https://en.wikivoyage.org/wiki/${destination}`),
      );
    } catch (error) {
      fetchErrors.push(
        error instanceof Error ? error.message : `Unknown error for ${destination}`,
      );
    }
  }

  // FALLBACK: If every download failed, use the built-in hardcoded notes.
  if (pages.length === 0) {
    console.warn("WikiVoyage fetches failed; using built-in Cornwall travel notes as a fallback.");
    console.warn(fetchErrors.join("\n"));
    pages.push(
      ...fallbackTravelKnowledge.map((content, index) =>
        new Document({
          pageContent: content,
          metadata: { source: `builtin-cornwall-${index + 1}` },
        }),
      ),
    );
  }

  // Split full pages into overlapping chunks of 1 024 characters.
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1024,
    chunkOverlap: 128,
  });
  const chunks = await splitter.splitDocuments(pages);

  // Embed all chunks and store them in an in-memory vector store.
  console.log(`Embedding ${chunks.length} travel-information chunks ...`);
  const vectorStore = await MemoryVectorStore.fromDocuments(
    chunks,
    new OpenAIEmbeddings(),
  );
  console.log("Travel information index ready.\n");

  return vectorStore.asRetriever(4); // fetches the top-4 most relevant chunks
}

// =============================================================================
// 5. Helper – extract plain text from a BaseMessage
// =============================================================================

/**
 * Return the string content of any BaseMessage regardless of whether
 * `content` is already a string or an array of content parts.
 */
function messageText(message: BaseMessage | undefined): string {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  // Multi-modal messages store content as an array; join the text parts.
  return message.content
    .map((part) => ("text" in part ? part.text : ""))
    .join("");
}


// =============================================================================
// 6. Helper – wrap a child agent as a LangGraph node function
// =============================================================================

/**
 * Converts a `createAgent` agent into the node function signature that
 * LangGraph expects. It passes the full history to the agent, then returns
 * only the new messages so LangGraph can append them to the state.
 */
function childAgentNode(
  agent: ReturnType<typeof createAgent>,
): (state: WorkflowState) => Promise<Partial<WorkflowState>> {
  return async (state) => {
    const result = await agent.invoke({ messages: state.messages });
    // Return only the messages the agent added (not the history it received).
    return { messages: result.messages.slice(state.messages.length) };
  };
}

// =============================================================================
// 7. Weather tool factory (wraps Open-Meteo API)
// =============================================================================

/**
 * Build the LangChain tool that fetches real weather data from Open-Meteo.
 * Defined as a factory so it is instantiated inside `createWorkflow()`.
 */
function getWeatherTool() {
  return tool(
    async ({ location, forecast_days }) =>
      getWeatherForecast(location, forecast_days),
    {
      name: "get_weather_forecast",
      description:
        "Get current weather and a daily forecast for a named location using Open-Meteo.",
      schema: z.object({
        location: z.string().min(2).describe("Town, city, or other place name."),
        forecast_days: z
          .number()
          .int()
          .min(1)
          .max(7)
          .default(3)
          .describe("Number of forecast days to return, from 1 to 7."),
      }),
    },
  );
}



// =============================================================================
// 8. Create the full LangGraph workflow (agents + router + compiled graph)
// =============================================================================

async function createWorkflow() {

  // ---- Validate prerequisites ----
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY in your environment or .env file.");
  }

  const model = new ChatOpenAI({
    model: "gpt-5-mini",
    useResponsesApi: true,
  });

  // ---- Knowledge base ----
  const retriever = await buildTravelRetriever();

  // ---- Tool: semantic search over travel knowledge base ----
  const searchTravelInfo = tool(
    async ({ query }) => {
      const documents = await retriever.invoke(query);
      return documents.map((document) => document.pageContent).join("\n---\n");
    },
    {
      name: "search_travel_info",
      description:
        "Search WikiVoyage travel information for Cornwall and nearby regions.",
      schema: z.object({ query: z.string() }),
    },
  );

  // ---- Sub-agent: Travel Information ----
  const travelInfoAgent = createAgent({
    model,
    tools: [searchTravelInfo, getWeatherTool()],
    name: "travel_info_agent",
    systemPrompt:
      "You are the Cornwall travel-information specialist. Use the travel search and weather tools when needed. Only answer travel questions focused on Cornwall, England. Distinguish forecast data from observed current conditions and keep units and dates.",
  });

  // ---- Sub-agent: Accommodation Booking ----
  const accommodationAgent = createAgent({
    model,
    tools: [hotelAvailabilityTool, bnbAvailabilityTool],
    name: "accommodation_booking_agent",
    systemPrompt:
      "You are the Cornwall accommodation specialist. For availability and prices, use the supplied tools; never invent offers. If the user does not specify hotel or BnB, check both. If the user omits room count, check one room. Clearly label the BnB offers as sample/mock data, not live inventory. Prices are GBP per room per night.",
  });

  // ---- Guardrail model: classifies whether the query is about Cornwall travel ----
  const guardrailModel = model.withStructuredOutput(
    z.object({
      is_allowed: z
        .boolean()
        .describe(
          "True only for a travel question about Cornwall, England, including local weather and accommodation.",
        ),
      reason: z.string(),
    }),
  );

  // ---- Router model: picks the correct sub-agent for a valid query ----
  const routerModel = model.withStructuredOutput(
    z.object({
      agent: z.enum(["travel_info_agent", "accommodation_booking_agent"]),
    }),
  );

  // --------------------------------------------------------------------------
  // Router node: guardrail check → route decision
  // --------------------------------------------------------------------------

  const routerNode = async (state: WorkflowState) => {
    const lastMessage = state.messages.at(-1);
    if (!lastMessage) {
      throw new Error("Cannot route a conversation with no messages.");
    }

    // Step 1 – Guardrail: reject anything not about Cornwall travel.
    const guardrail = await guardrailModel.invoke([
      {
        role: "system",
        content:
          "Classify whether the user's request is both travel-related and focused on Cornwall, England. Accept Cornwall destinations, attractions, travel information, local weather, hotels, BnBs, prices, and availability. Reject unrelated requests and travel requests about other regions or countries. Use prior conversation context when the user refers to a place indirectly.",
      },
      ...state.messages.slice(-8), // Keep up to the last 8 messages so indirect references ("that town") are resolved
    ]);

    if (!guardrail.is_allowed) {
      return { route: "guardrail_refusal" as const };
    }

    // Step 2 – Routing: send valid Cornwall queries to the right sub-agent.
    // Call the router classifier with only the last message for a clean routing signal
    const routing = await routerModel.invoke([
      {
        role: "system",
        content:
          "Route travel information, attractions, and weather questions to travel_info_agent. Route hotel/BnB accommodation, room availability, and price questions to accommodation_booking_agent.",
      },
      lastMessage,
    ]);

    //Store the chosen agent name in state; LangGraph uses it to pick the next edge
    return { route: routing.agent };
  };

  // --------------------------------------------------------------------------
  // Assemble the LangGraph graph
  // --------------------------------------------------------------------------

  const graph = new StateGraph(workflowState)

    // -- Nodes --
    .addNode("router_agent", routerNode)
    .addNode("travel_info_agent", childAgentNode(travelInfoAgent))
    .addNode("accommodation_booking_agent", childAgentNode(accommodationAgent))
    .addNode("guardrail_refusal", async () => ({ // Guardrail-refusal node injects the refusal text with no LLM call
      messages: [new AIMessage(REFUSAL_MESSAGE)],
    }))

    // -- Edges --
    .addEdge(START, "router_agent") // Every conversation always starts at router_agent
    .addConditionalEdges("router_agent", (state) => state.route, { // After routing, branch to whichever node state.route names
      travel_info_agent: "travel_info_agent",
      accommodation_booking_agent: "accommodation_booking_agent",
      guardrail_refusal: "guardrail_refusal",
    })
    .addEdge("travel_info_agent", END) // All three leaf nodes lead directly to END; no further processing is needed
    .addEdge("accommodation_booking_agent", END)
    .addEdge("guardrail_refusal", END)
    // Compile with an in-memory checkpointer so conversation history persists across turns
    .compile({ checkpointer: new MemorySaver() });

  return graph;
}

// =============================================================================
// 9. CLI chat loop
// =============================================================================

/**
 * Interactive REPL that keeps a single conversation thread alive until the
 * user types "exit" or "quit".
 */
async function runChatLoop(
  graph: Awaited<ReturnType<typeof createWorkflow>>,
): Promise<void> {
  // Create a readline interface to read from the terminal line by line
  const readline = createInterface({ input: stdin, output: stdout });
  // A UUID thread-id keeps this conversation isolated in the MemorySaver checkpointer
  const threadId = randomUUID();
  const config = { configurable: { thread_id: threadId } };

  console.log(`Conversation thread: ${threadId}`);
  console.log("UK Travel Assistant (type 'exit' to quit)");

  try {
    while (true) {
      // Read the user's input; handle closed stdin gracefully.
      let question: string;
      try {
        question = (await readline.question("You: ")).trim();
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;
        // Piped input reached EOF — exit cleanly instead of crashing
        if (code === "ERR_INPUT_CLOSED" || code === "ERR_USE_AFTER_CLOSE") {
          break;
        }
        throw error;
      }

      if (["exit", "quit"].includes(question.toLowerCase())) break;
      // Skip blank lines instead of sending an empty message to the graph
      if (!question) continue;

      // Invoke the graph and print the final assistant message.
      const result = await graph.invoke(
        { messages: [{ role: "user", content: question }] },
        config,
      );
      console.log(`Assistant: ${messageText(result.messages.at(-1))}\n`);
    }
  } finally {
    // Always close readline even if an error interrupts the loop
    readline.close();
  }
}


// =============================================================================
// 10. Entry point
// =============================================================================

async function main(): Promise<void> {
  const graph = await createWorkflow();
  await runChatLoop(graph);
}

main().catch((error: unknown) => {
  console.error("Travel assistant failed:", error);
  // Set a non-zero exit code so shells and CI pipelines can detect failure
  process.exitCode = 1;
});
