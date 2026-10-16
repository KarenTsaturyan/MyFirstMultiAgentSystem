# TypeScript LangGraph Travel Assistant

A Cornwall travel assistant built with **LangChain**, **LangGraph**, and **OpenAI**.
It demonstrates a real multi-agent workflow: a router, a guardrail, two specialist agents, and three tools — all wired together with a stateful graph.

---

## Quick Setup

> Requires **Node.js ≥ 22** and **npm**.

```bash
cd typescript
npm install
cp .env.example .env
# Open .env and paste your OpenAI key
```

`.env` minimum:
```
OPENAI_API_KEY=
```

No other API keys are needed. The weather tool calls Open-Meteo for free.

```bash
npm start        # build + run
npm run dev      # build + run with --watch (auto-restarts on file change)
```

On startup the app downloads four WikiVoyage pages, embeds them, and stores them in memory.  
This takes ~20–40 s on a cold start. When you see `Travel information index ready.` the `You:` prompt appears.

---

## File Map

```
src/
├── main_07_02.ts            ← Chapter 7-2: multi-agent (router + guardrail + 2 agents)
├── hotel_booking.ts         ← SQLite database setup, query functions & LangChain tools
├── seed_data.ts             ← Clean seed datasets for hotels and BnBs
├── open_meteo.ts            ← Free weather API helper (no API key needed)
```

---

## How Each File Works

### `main_07_02.ts` — Multi-agent workflow

Adds a **router**, a **guardrail**, and a **second specialist agent**:

```
User
  │
  ▼
router_agent
  ├─[off-topic]────► guardrail_refusal ──► END
  ├─[travel info]──► travel_info_agent ──► END
  └─[booking]──────► accommodation_booking_agent ──► END
```

**The flow step by step:**

1. **Router node** receives the user message
2. **Guardrail check** — structured-output LLM: *"Is this about Cornwall travel?"*
   - **No** → `route = "guardrail_refusal"` → polite refusal, done
   - **Yes** → continue to step 3
3. **Routing** — structured-output LLM: *"Is this travel info or accommodation?"*
   - Sets `route = "travel_info_agent"` or `"accommodation_booking_agent"`
4. **LangGraph conditional edge** reads `state.route` and jumps to the right node
5. Chosen **sub-agent** runs its ReAct loop (think → call tool → observe → reply)
6. Graph reaches `END`

**State carried through the graph:**

```typescript
{
  messages: BaseMessage[],   // full conversation history (LangGraph appends automatically)
  route: "travel_info_agent" | "accommodation_booking_agent" | "guardrail_refusal"
}
```

**Key sections in the file:**

| Section | What it does |
|---|---|
| `buildTravelRetriever()` | Downloads WikiVoyage pages, chunks + embeds them, returns a retriever |
| `searchTravelInfo` tool | Calls the retriever with a query, returns top-4 chunks as text |
| `getWeatherTool()` | Wraps the Open-Meteo helper as a LangChain tool |
| `travelInfoAgent` | ReAct agent with search + weather tools |
| `accommodationAgent` | ReAct agent with hotel + BnB tools |
| `guardrailModel` | `model.withStructuredOutput(...)` → returns `{ is_allowed: bool }` |
| `routerModel` | `model.withStructuredOutput(...)` → returns `{ agent: "..." }` |
| `routerNode` | Runs guardrail → then router → writes `{ route }` to state |
| `StateGraph` | Wires all nodes + edges + checkpointer into a compiled graph |
| `runChatLoop()` | Terminal REPL; keeps `thread_id` across turns for memory |

---

### `hotel_booking.ts` — Real SQLite Database Implementation

This is **NOT a mock in-memory store**. It is a real, persistent SQLite database powered by Node.js 22's built-in `node:sqlite` module (zero external npm packages required).

- **Database file location**: `data/cornwall_hotels.db`
- **Initial seed datasets**: Stored in [`src/seed_data.ts`](file:///c:/Users/GBM/OneDrive/Рабочий%20стол/AI_DEV/multi_agent/typescript/src/seed_data.ts) to keep the DB code clean and focused.

#### Tables & Schema

On first run, `initDatabase()` creates three tables with foreign keys and town indices, seeding them only if empty:

1. **`hotels`**: `hotel_id`, `hotel_name`, `town`, `address`, `rating`, `description`
2. **`hotel_room_offers`**: `offer_id`, `hotel_id` (FK), `available_rooms`, `price_single`, `price_double`
3. **`bnbs`**: `bnb_id`, `bnb_name`, `town`, `available_rooms`, `price_per_room`

#### Query Functions & Tools

The file exports two query functions and wraps them as LangChain tools for `accommodation_booking_agent`:

- **`findHotelOffers(town, rooms, roomType)`**: Runs a parameterized SQL `JOIN`:
  ```sql
  SELECT h.hotel_name, h.town, h.address, h.rating,
         offer.available_rooms, offer.price_double AS price_per_night_gbp
  FROM hotels AS h
  JOIN hotel_room_offers AS offer ON offer.hotel_id = h.hotel_id
  WHERE lower(h.town) = lower(?) AND offer.available_rooms >= ?
  ORDER BY price_per_night_gbp ASC
  ```
- **`findBnbOffers(town, rooms)`**: Runs a parameterized query against `bnbs`:
  ```sql
  SELECT bnb_id, bnb_name, town, available_rooms,
         price_per_room AS price_per_room_gbp
  FROM bnbs
  WHERE lower(town) = lower(?) AND available_rooms >= ?
  ORDER BY price_per_room ASC
  ```
- **Exported tools**:
  ```typescript
  export const hotelAvailabilityTool = tool(...) // check_hotel_availability
  export const bnbAvailabilityTool   = tool(...) // check_bnb_availability
  ```

---

## 🗄️ Inspecting the SQLite Database

You can inspect the database file (`data/cornwall_hotels.db`) directly using any of these methods:

### Method 1 — Built-in npm command (Easiest, zero install)

Run the included inspection script to view live sample data formatted in console tables:

```powershell
npm run db:inspect
```

Output:
```
=== HOTELS (Top 5) ===
┌─────────┬──────────┬─────────────────────┬──────────────┬────────┐
│ (index) │ hotel_id │ hotel_name          │ town         │ rating │
├─────────┼──────────┼─────────────────────┼──────────────┼────────┤
│ 0       │ 1        │ 'Seaview Hotel'     │ 'Newquay'    │ 4.5    │
│ 1       │ 2        │ 'Harbour Inn'       │ 'Falmouth'   │ 4.2    │
...

=== BNBS (Top 5) ===
┌─────────┬────────┬───────────────────────┬──────────────┬────────────────┐
│ (index) │ bnb_id │ bnb_name              │ town         │ price_per_room │
...
```

### Method 2 — Run custom SQL queries via Node 22

You can execute any custom SQL query directly from your terminal using Node 22's `node:sqlite`:

**In PowerShell:**
```powershell
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('data/cornwall_hotels.db'); console.table(db.prepare('SELECT h.hotel_name, h.town, o.available_rooms, o.price_double FROM hotels h JOIN hotel_room_offers o ON h.hotel_id = o.hotel_id WHERE h.town = ?').all('Newquay'));"
```

### Method 3 — Using the `sqlite3` CLI

If you have `sqlite3` installed on your machine:

```powershell
# Open the database file
sqlite3 data/cornwall_hotels.db

# Useful SQLite commands inside the prompt:
sqlite> .tables                           -- View all tables (hotels, hotel_room_offers, bnbs)
sqlite> .schema hotels                    -- View the schema of the hotels table
sqlite> .mode table                       -- Format queries as pretty tables
sqlite> SELECT hotel_name, town, rating FROM hotels WHERE town = 'Newquay';
sqlite> SELECT * FROM bnbs WHERE available_rooms >= 3;
sqlite> .exit                             -- Exit the sqlite prompt
```

### Method 4 — VS Code / IDE GUI Extensions

If you prefer a visual database browser inside VS Code:
1. Open the Extensions sidebar (`Ctrl+Shift+X`).
2. Search and install **"SQLite Viewer"** (by Florian Klampfer).
3. In your file explorer, simply click on `data/cornwall_hotels.db`.
4. It opens an interactive GUI where you can browse tables, filter columns, sort rows, and paginate data.

---

### `open_meteo.ts` — Is it MCP? Does it need an API key?

**It is NOT MCP.** It is a plain TypeScript helper that calls two public REST APIs with `fetch`.

**No API key required.** Open-Meteo is a free, open-source weather API for non-commercial use.  
Attribution is required under CC BY 4.0 — the tool includes this in every response automatically.

**Two-step process:**

```
Step 1 — Geocoding:  location name → latitude / longitude
  GET https://geocoding-api.open-meteo.com/v1/search?name=Newquay&count=1

Step 2 — Forecast:   lat/lon → weather data
  GET https://api.open-meteo.com/v1/forecast?latitude=...&longitude=...
```

The `getWeatherForecast(location, forecastDays)` function:
1. Resolves any place name to coordinates
2. Fetches current conditions + N-day daily forecast
3. Translates WMO weather codes (`61 → "slight rain"`) to human-readable strings
4. Returns structured JSON the LLM can read and explain

**Limits:** ~10 000 free API calls per day. More than enough for development.

---

## How to Build an Agent Workflow

### Step 1 — Define your state

The state is the "shared memory" object that flows between every node.

```typescript
const workflowState = new StateSchema({
  messages: MessagesValue,          // LangGraph auto-appends new messages
  route: z.enum(["agent_a", "agent_b", "refused"]).default("refused"),
});
```

Only put data in state that multiple nodes need to read or write.

---

### Step 2 — Create your tools

A tool is a typed async function the LLM can call. It must have a name, description, and Zod schema.

```typescript
const myTool = tool(
  async ({ query }) => {
    const result = await someApi.search(query);
    return JSON.stringify(result);
  },
  {
    name: "my_tool",
    description: "What this tool does and WHEN the LLM should call it.",
    schema: z.object({ query: z.string() }),
  },
);
```

> **Tip:** Write the `description` like you are explaining the tool to the LLM.
> The LLM reads it to decide *when* to call the tool, not just *what* it does.

---

### Step 3 — Create your agents

An agent is an LLM in a ReAct loop: think → call tool → observe → think again.

```typescript
const myAgent = createAgent({
  model,
  tools: [myTool],
  name: "my_agent",
  systemPrompt: "You are a specialist. Only answer questions about X.",
});
```

Wrap it as a LangGraph node with the `childAgentNode()` helper so it fits the graph's function signature.

---

### Step 4 — Add a router node

The router reads state and writes a `route` value. Use structured output so you get a typed enum — not free text that could break.

```typescript
const routerModel = model.withStructuredOutput(
  z.object({ agent: z.enum(["agent_a", "agent_b"]) })
);

const routerNode = async (state) => {
  const routing = await routerModel.invoke([systemMsg, state.messages.at(-1)]);
  return { route: routing.agent };
};
```

---

### Step 5 — Add a guardrail

A guardrail is a lightweight classifier that runs *before* routing to reject off-topic input cheaply.

```typescript
const guardrailModel = model.withStructuredOutput(
  z.object({ is_allowed: z.boolean(), reason: z.string() })
);

const guardrail = await guardrailModel.invoke([systemMsg, ...state.messages.slice(-8)]);
if (!guardrail.is_allowed) return { route: "refused" };
```

Use `slice(-8)` to pass recent history so indirect references (*"what about that town?"*) are handled correctly.

---

### Step 6 — Wire the graph

```typescript
const graph = new StateGraph(workflowState)
  .addNode("router",  routerNode)
  .addNode("agent_a", childAgentNode(agentA))
  .addNode("agent_b", childAgentNode(agentB))
  .addNode("refused", async () => ({ messages: [new AIMessage("I can't help with that.")] }))

  .addEdge(START, "router")
  .addConditionalEdges("router", (state) => state.route, {
    agent_a: "agent_a",
    agent_b: "agent_b",
    refused: "refused",
  })
  .addEdge("agent_a", END)
  .addEdge("agent_b", END)
  .addEdge("refused", END)

  .compile({ checkpointer: new MemorySaver() });
```

---

### Step 7 — Run with a persistent thread

```typescript
const config = { configurable: { thread_id: randomUUID() } };
const result = await graph.invoke(
  { messages: [{ role: "user", content: question }] },
  config,
);
```

The `thread_id` is the key that `MemorySaver` uses to persist conversation history across multiple `.invoke()` calls.

---

## Techniques Reference

### RAG — Retrieval-Augmented Generation

**What it is:** Instead of relying on the LLM's training data, you inject relevant documents into the prompt at runtime. The LLM grounds its answer in those documents.

**The pipeline used here:**

```
Documents (WikiVoyage pages)
    │
    ▼  chunk  →  1024 chars, 128 overlap
    ▼  embed  →  OpenAI text-embedding-ada-002
    ▼  store  →  MemoryVectorStore (in-memory)
    │
User query
    │
    ▼  embed query
    ▼  cosine similarity search → top-4 chunks
    ▼  inject chunks into LLM prompt as context
    │
    ▼  LLM answer grounded in real documents
```

**Key parameters:**

| Parameter | Value | Effect |
|---|---|---|
| `chunkSize` | 1024 chars | Larger = more context per chunk, but less precise retrieval |
| `chunkOverlap` | 128 chars | Prevents cutting sentences at chunk boundaries |
| `asRetriever(4)` | top-4 chunks | More chunks = richer context but longer prompt |

**When to use RAG:**
- The LLM doesn't have the data in its training set
- You need answers from private or frequently updated documents
- You want to reduce hallucination by grounding answers in real text

**Variants worth knowing:**
- **Persistent store** (Chroma, Pinecone, pgvector) — survives restarts; use for production
- **Hybrid search** — combine semantic embeddings + keyword (BM25) for better recall
- **Re-ranking** — use a cross-encoder to re-score the top-N chunks before injection

---

### Structured Output (Routing & Classification)

Force the LLM to return a typed object instead of free text:

```typescript
const classifier = model.withStructuredOutput(
  z.object({
    category: z.enum(["A", "B", "C"]),
    confidence: z.number().min(0).max(1),
  })
);
const result = await classifier.invoke([...messages]);
// result.category is "A" | "B" | "C" — TypeScript knows the type
```

**Why it matters for routing:** Free-text routing breaks if the LLM adds extra words. Structured output guarantees a valid enum value every time.

---

### ReAct Agent Loop

ReAct = **Re**asoning + **Act**ing. The agent repeats until it has a final answer:

```
Think:   "The user wants weather in Newquay. I should call get_weather_forecast."
Act:     call get_weather_forecast({ location: "Newquay", forecast_days: 3 })
Observe: { current: { temperature_celsius: 17, conditions: "partly cloudy" }, ... }
Think:   "I now have the data. I can answer."
Reply:   "The weather in Newquay today is partly cloudy, 17 °C..."
```

`createAgent` handles the loop automatically. You provide tools + a system prompt.

---

### Conditional Edges (Graph Branching)

LangGraph picks the next node by calling a selector function on the current state:

```typescript
.addConditionalEdges("router", (state) => state.route, {
  agent_a: "agent_a",
  agent_b: "agent_b",
  refused: "refused",
})
```

This replaces `if/else` chains with a declarative routing table — easier to read and extend.

---

### Guardrail Pattern

```
User message
    │
    ▼  guardrail (fast, cheap structured-output call)
    ├─ is_allowed: false → refuse immediately  ← no tool calls, no agent overhead
    └─ is_allowed: true  → pass to router
```

**Best practices:**
- Use a smaller/faster model for the guardrail (e.g. `gpt-4o-mini` not `gpt-4o`)
- Pass recent conversation history so indirect references resolve correctly
- Keep the system prompt tight and binary (yes / no only)

---

### In-Memory vs Persistent Checkpointing

| Checkpointer | Used here | Behaviour |
|---|---|---|
| `MemorySaver` | ✅ Yes | State lives in RAM; lost when the process exits |
| `SqliteSaver` | ❌ No | Persisted to a local `.db` file; survives restarts |
| `PostgresSaver` | ❌ No | Persisted to Postgres; survives restarts and scales horizontally |

To switch: replace `new MemorySaver()` in `.compile(...)`. Everything else stays the same.

---

### Tool Design Checklist

| Principle | Example from this project |
|---|---|
| One responsibility per tool | `check_hotel_availability` only checks hotels; BnBs have their own tool |
| Return structured data | Tools return JSON strings the LLM can parse and explain |
| Return error objects, not exceptions | `{ message: "No hotels found in X" }` instead of throwing |
| Write descriptions for the LLM | Mention *when* to use the tool, not just *what* it does |
| Use Zod defaults | `num_rooms.default(1)` so the LLM doesn't have to always specify it |
