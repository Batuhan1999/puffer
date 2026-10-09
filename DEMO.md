# Puffer demo

This guide runs the Puffer demo on the iPhone 17 Pro simulator (`1D4B8ECF-A717-442E-9828-FCB3F93229DB`), paired with the hosted relay at `https://puffer.fly.dev`. The demo shows two things. Puffer finds documents, notes and photos on the phone by meaning. An agent reads them over plain HTTP, under the access the user granted in Puffer.

The demo library belongs to a fictional person, Alex Morgan, who lives at 14 Linden Row, Apartment 3B, in the fictional city of Harborview. Every company, address, phone number and reference number in it is made up.

The demo tools live in the session scratchpad. In this guide, `$DEMO` stands for that path:

```sh
DEMO=/private/tmp/claude-501/-Users-batuhancakir-Documents-Dev-learning-local-turbopuffer/5c9dc602-fa08-4ce7-9873-9159ae34289b/scratchpad
```

| Path | What it is |
| --- | --- |
| `$DEMO/demo-docs/build_library.py` | Generates the 29 documents, the 12 notes and 3 photos, and syncs the documents into On My iPhone. Rerunning it changes nothing that is already in place. |
| `$DEMO/demo-docs/seed-notes.sh` | Syncs the notes into Puffer's "Apple Notes" source on the simulator. |
| `$DEMO/demo/connect-agent.sh` | Connects an agent by message and saves its key. |
| `$DEMO/demo/demo.sh` | The agent scenes, as numbered `curl` calls. |

## What is on the phone

The documents are in the Files app under On My iPhone, in seven folders.

| Folder | Files |
| --- | --- |
| Home | Apartment lease (PDF), home contents insurance policy (PDF), washing machine warranty (PDF) and quick guide, coffee machine manual, router setup, move-in checklist |
| Travel | Flight booking to Lisbon (PDF), hotel booking (PDF), train ticket to Port Ellis (PDF), Lisbon itinerary, passport renewal checklist |
| Money | Electricity bill (PDF), internet bill (PDF), laptop receipt (PDF), yearly expenses 2025 |
| Health | Vaccination record (PDF), prescription (PDF), gym membership contract (PDF), dentist appointment |
| Work | Q4 planning meeting notes, Fieldnote 2.3 project plan (PDF), team offsite in Port Ellis |
| Recipes | Banana bread, chickpea and spinach curry, sourdough starter |
| Car | Service invoice (PDF), tire changes, motor insurance card |

The file dates spread over the last 18 months, so date filters and Recent Changes have something to show. The PDFs carry a title, author, subject and keywords.

The "Apple Notes" source holds 12 notes. They include a Lisbon packing list, follow-ups from the Q4 meeting, a car service reminder, the guest Wi-Fi password, a shopping list, health to-dos, gift ideas, a reading list, and four notes about "offline mode" for the Fieldnote app, written on different days.

Photos holds the simulator's sample photos plus three generated ones: a boarding pass screenshot, a grocery receipt, and a whiteboard with the Fieldnote timeline.

## Start the demo

1. Start Metro and Puffer on the simulator. Check first that no build is running (`pgrep -fl xcodebuild`).

   ```sh
   cd /Users/batuhancakir/Documents/Dev/learning/local-turbopuffer/prototype
   LANG=en_US.UTF-8 npx expo run:ios --device 1D4B8ECF-A717-442E-9828-FCB3F93229DB
   ```

   If the app is already installed, `$DEMO/relaunch.sh` restarts Metro and relaunches the app instead.

2. Pair the simulator with the hosted relay. Open the relay's pairing link with `xcrun simctl openurl 1D4B8ECF-A717-442E-9828-FCB3F93229DB '<puffer://pair?... link>'` and tap "Pair with puffer.fly.dev".

3. Check the demo agent. Puffer already lists "Demo Agent" with Everything and photos, and its key is in `$DEMO/demo-agent-key.txt`. The phone sends its agent list to the relay it syncs with, so that key should work on the hosted relay too. Check it with scene 1:

   ```sh
   PUFFER_BASE=https://puffer.fly.dev $DEMO/demo/demo.sh 1
   ```

   If the answer is `invalid_token`, connect a new agent. The script opens the approve link in the simulator. In Puffer, choose **Everything**, turn on **Include Photos**, and tap **Approve**. In the simulator, a tap does not flip the switch. Swipe the switch to the right instead. Then pass `PUFFER_KEY_FILE=$DEMO/demo-agent-key-hosted.txt` to `demo.sh`.

   ```sh
   PUFFER_BASE=https://puffer.fly.dev $DEMO/demo/connect-agent.sh "Demo Agent" $DEMO/demo-agent-key-hosted.txt
   ```

4. Check that "Waiting for You" in the Agents tab is empty. An open review there holds any new request with the same question, so `demo.sh` would print `waiting_for_user`. Deny or approve the old requests first.

5. To restore the library after a demo, run `python3 $DEMO/demo-docs/build_library.py`, then `$DEMO/demo-docs/seed-notes.sh`. Then open Puffer, or tap **Check Folders for Changes** in Library.

To run against a local relay instead, start it with `cd prototype/relay && npm run relay`, pair with the link it prints, and leave `PUFFER_BASE` unset. The scripts then use `http://localhost:8787`.

## Try it in the app

Type these into the Search tab. Each one names what it should find.

| Search | Should find |
| --- | --- |
| how much was the deposit for the apartment | `apartment-lease.pdf` and `expenses-2025.md`: 3,540.00 EUR, paid on 15 April 2025, reference DEP-2025-0388 |
| when do I fly to Lisbon | `flight-booking-lisbon.pdf`: SW 1432 on 14 November 2026 at 07:40, booking K7QM2P. The "Lisbon packing list" note comes up too. |
| until when can I cancel the hotel | `hotel-booking-lisbon.pdf`: free cancellation until 7 November 2026, 18:00 |
| washing machine shows E21 | `washing-machine-quick-guide.md`: clean the drain pump filter behind the flap at the bottom right |
| how do I descale the coffee machine | `coffee-machine-manual.txt`: 500 ml water and 100 ml descaler, hold both cup buttons for 5 seconds |
| laptop serial number | `laptop-receipt.pdf`: CX14-7F3K-22918, bought 18 February 2026 |
| how much did the car cost last year | `expenses-2025.md`: car subtotal 2,068.35 EUR |
| how do I cancel the gym | `gym-membership-contract.pdf`: 4 weeks' notice to the end of a month |
| my seat on the train to Port Ellis | `train-ticket-port-ellis.pdf`: train CR 518, coach 7, seat 64 |
| boarding pass | The boarding pass screenshot, a photo |
| whiteboard with the launch date | The whiteboard photo with the Fieldnote 2.3 timeline |
| guest wifi password | The "Guest Wi-Fi" note: LindenRow-Guest, harbor-lantern-58 |
| what do I need to buy for the curry | The "Shopping list" note and `chickpea-spinach-curry.md` |
| when is the car due for service | The "Car service reminder" note (68,950 km on 4 October) and `car-service-record.pdf` (next service at 76,000 km or March 2027) |
| what did we agree after the planning meeting | `q4-planning-meeting-notes.md` and the "Fieldnote 2.3 follow-ups" note |

The note questions show one answer drawn from two places. The car question pairs a note written last week with an invoice from March. The curry question pairs a shopping list with a recipe.

Library also shows the sources (Photos, On My iPhone, Apple Notes, Shared with Puffer) and Recent Changes.

## The agent scenes

Run every scene, or name the scenes to run:

```sh
PUFFER_BASE=https://puffer.fly.dev PAUSE=1 $DEMO/demo/demo.sh
PUFFER_BASE=https://puffer.fly.dev $DEMO/demo/demo.sh 9 10
```

`PAUSE=1` waits for Enter between scenes. Each scene prints the request it sends, then a short summary of the answer, never the base64 of a file or a photo.

| Scene | What the agent does | What comes back |
| --- | --- | --- |
| 1 | Asks "apartment deposit" | The lease passage and the expenses line with 3,540.00 EUR |
| 2 | Asks for the banana bread recipe with `include_documents: "text"` | The whole recipe as text |
| 3 | Asks for the lease with `include_documents: "file"` | The original files: `apartment-lease.pdf` (`application/pdf`, about 20 KB) and `expenses-2025.md`, sizes only |
| 4 | Narrows with filters: documents from September 2026, only photos, only the "Apple Notes" source | The two September bills, the receipt photo, the "Guest Wi-Fi" note |
| 5 | Asks for "boarding pass" photos with `include_images: true` | The boarding pass as a JPEG, title and size only |
| 6 | Reads the change feed, then a file lands in On My iPhone/Home and the shopping list note gets "Oat milk" | The second call, with the cursor, lists only `building-notice.txt` as added and `Shopping list.txt` as updated |
| 7 | Asks for "a violin" | `nothing_found` |
| 8 | Reads `/start` and `/openapi.json` without a key | The connect guide for agents, and the five operations |
| 9 | Lists the sources, then the 5 newest Apple Notes with their text | The sources with item counts, then the notes newest first |
| 10 | Asks "offline mode" in Apple Notes with `sort: "recent"` | The four offline mode notes, newest first |
| 11 | Asks "next car service", then "Lisbon trip luggage packing" | The car note with the service invoice, then the packing list note with the itinerary and the flight booking |

Scenes 6 and 10 change files on the simulator, so run them on the Mac that runs the simulator. Scene 6 removes its building notice and restores the notes before it starts, so it can run again.

Puffer answers one agent at most 5 times a minute without asking. Past that, a request waits for review on the phone. `demo.sh` paces itself to stay under the limit and prints how long it waits. A full run takes about 3 minutes.

## Apple Notes through Shortcuts

On the simulator there is no Notes app. `seed-notes.sh` writes the notes to a file in Puffer's container and opens `puffer://dev-sync-notes`. That debug-only route calls the same native sync that the "Sync Notes to Puffer" Shortcuts action calls. On an iPhone, a Shortcuts automation does this instead.

Build the shortcut on the iPhone:

1. In Shortcuts, tap **+** to make a new shortcut.
2. Add **Find Notes** and leave it on **All Notes**.
3. Add **Sync Notes to Puffer**. Its input is the notes from Find Notes.
4. Run the shortcut once. Puffer's Library now shows the "Apple Notes" source.
5. In the **Automation** tab, add a **Time of Day** automation, set it to **Daily**, choose **Run Immediately**, and pick the shortcut.

"Sync Notes to Puffer" replaces the whole source, so a note deleted in Notes leaves Puffer at the next run. "Add to Puffer" adds or updates single notes and removes nothing.

## Not shown

The demo does not show push notifications to agents, because the simulator has no webhook receiver set up for them. It also does not show how long a first pass over a large photo library takes. The simulator holds only 24 photos.
