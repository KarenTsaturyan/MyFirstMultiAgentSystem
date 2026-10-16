// Initial seed data used to populate the SQLite database on first run.

// [hotel_name, town, address, rating, description]
export const seedHotels = [
  ["Seaview Hotel", "Newquay", "1 Beach Rd, Newquay", 4.5, "A beautiful hotel overlooking the sea."],
  ["Harbour Inn", "Falmouth", "12 Harbour St, Falmouth", 4.2, "Charming inn near the harbour."],
  ["Cornish Retreat", "St Austell", "5 Retreat Ln, St Austell", 4.0, "Relaxing retreat in the heart of Cornwall."],
  ["Penzance Palace", "Penzance", "22 Promenade, Penzance", 4.7, "Luxury hotel with sea views."],
  ["The Camborne Arms", "Camborne", "8 Main St, Camborne", 4.1, "Friendly hotel in Camborne."],
  ["Hayle Haven", "Hayle", "3 River Rd, Hayle", 4.3, "Comfortable stay near the river."],
  ["Land's End Lodge", "Land's End", "Land's End Rd, Land's End", 4.6, "Stay at the edge of England."],
  ["Bude Beach Hotel", "Bude", "7 Beach Parade, Bude", 4.4, "Steps from the sand."],
  ["Padstow Quay Inn", "Padstow", "2 Quay St, Padstow", 4.5, "Quayside inn with great food."],
  ["St Ives Bay Resort", "St Ives", "9 Bay Rd, St Ives", 4.8, "Resort with stunning bay views."],
] as const;

// [available_rooms, price_single, price_double] — one row per hotel above
export const seedHotelPrices = [
  [5, 120, 180],
  [2, 95, 150],
  [8, 110, 170],
  [3, 130, 200],
  [4, 105, 160],
  [6, 99, 145],
  [2, 150, 220],
  [7, 115, 175],
  [5, 125, 185],
  [6, 140, 210],
] as const;

// [bnb_name, town, available_rooms, price_per_room_gbp]
export const seedBnbs = [
  ["Seaside BnB", "Newquay", 3, 80],
  ["Surfside Guesthouse", "Newquay", 2, 85],
  ["Harbour View BnB", "Falmouth", 4, 78],
  ["Seafarer's Rest", "Falmouth", 1, 90],
  ["Garden Gate BnB", "St Austell", 2, 82],
  ["Coastal Cottage BnB", "St Austell", 3, 88],
  ["Penzance Pier BnB", "Penzance", 2, 95],
  ["Cornish Charm BnB", "Penzance", 3, 87],
  ["Camborne Corner BnB", "Camborne", 2, 75],
  ["Rose Cottage BnB", "Camborne", 2, 79],
  ["Hayle Haven BnB", "Hayle", 3, 83],
  ["Dune View BnB", "Hayle", 1, 81],
  ["Land's End Lookout BnB", "Land's End", 2, 100],
  ["Atlantic Edge BnB", "Land's End", 2, 105],
  ["Bude Beach BnB", "Bude", 2, 77],
  ["Cliffside BnB", "Bude", 3, 80],
  ["Padstow Harbour BnB", "Padstow", 2, 92],
  ["Fisherman's Rest BnB", "Padstow", 2, 89],
  ["St Ives Bay BnB", "St Ives", 3, 97],
  ["Artists' Retreat BnB", "St Ives", 2, 102],
  ["Looe Riverside BnB", "Looe", 2, 84],
  ["Harbour Lights BnB", "Looe", 2, 86],
  ["Polperro Cove BnB", "Polperro", 2, 91],
  ["Smuggler's Rest BnB", "Polperro", 2, 93],
  ["Mevagissey Harbour BnB", "Mevagissey", 2, 90],
  ["Seafarer's BnB", "Mevagissey", 2, 88],
  ["Port Isaac View BnB", "Port Isaac", 2, 99],
  ["Fisherman's Cottage BnB", "Port Isaac", 2, 101],
  ["Fowey Quay BnB", "Fowey", 2, 94],
  ["Riverside Rest BnB", "Fowey", 2, 96],
] as const;
