#!/usr/bin/env python3
"""Builds the Puffer demo library and syncs it into the simulator's On My iPhone folder.

Rerunnable: unchanged files keep their bytes and dates, so a second run changes nothing in Puffer.
Usage: build_library.py [--no-sync] [--photos]
"""
import json
import os
import shutil
import subprocess
import sys
import textwrap
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
IMAGES = HERE / "images"
NOTES_JSON = HERE / "notes.json"
DEVICE = "1D4B8ECF-A717-442E-9828-FCB3F93229DB"
SIM_DATA = Path.home() / f"Library/Developer/CoreSimulator/Devices/{DEVICE}/data"
MANAGED = ["Home", "Travel", "Money", "Health", "Work", "Recipes", "Car"]
AUTHOR_SELF = "Alex Morgan"


def d(s):
    return textwrap.dedent(s).strip() + "\n"


def money(x):
    return f"{x:,.2f}"


# 2025 spending, one row per line item: (category, label, amount). The summary's totals are computed from it.
EXPENSES_2025 = [
    ("Housing", "Rent, previous flat (Jan to Apr, 4 x 960.00)", 4 * 960.00),
    ("Housing", "Rent, 14 Linden Row, Apartment 3B (May to Dec, 8 x 1,180.00)", 8 * 1180.00),
    ("Housing", "Service charges paid in advance (May to Dec, 8 x 210.00)", 8 * 210.00),
    ("Housing", "Electricity, Brightwatt Energy (May to Dec)", 512.40),
    ("Housing", "Internet, Fibrelink Fibre 500 (May to Dec, 8 x 44.99)", 8 * 44.99),
    ("Housing", "Home contents insurance, Northwind Mutual", 168.00),
    ("Housing", "Washing machine, Aquella WM-8400 (Brightline Electronics)", 649.00),
    ("Health and fitness", "Pulse Fitness membership (12 x 39.90)", 12 * 39.90),
    ("Health and fitness", "Pulse Fitness joining fee", 19.00),
    ("Health and fitness", "Bright Smile Dental, check-up and cleaning", 85.00),
    ("Car", "Motor insurance, Northwind Mutual", 540.00),
    ("Car", "Annual service, Riverside Auto (March 2025)", 342.00),
    ("Car", "Winter tire change and storage, Riverside Auto (November 2025)", 60.00),
    ("Car", "Fuel", 1126.35),
    ("Travel", "Coastline Rail tickets", 214.60),
]


def expenses_summary():
    lines = ["# Yearly expenses 2025", "",
             "Everything paid in 2025, grouped by category. Amounts in EUR.", ""]
    total = 0.0
    for category in dict.fromkeys(c for c, _, _ in EXPENSES_2025):
        rows = [(label, amount) for c, label, amount in EXPENSES_2025 if c == category]
        subtotal = sum(a for _, a in rows)
        total += subtotal
        lines += [f"## {category}", "", "| Item | Amount |", "| --- | ---: |"]
        lines += [f"| {label} | {money(amount)} |" for label, amount in rows]
        lines += [f"| **Subtotal {category.lower()}** | **{money(subtotal)}** |", ""]
    lines += [f"**Total spent in 2025: {money(total)} EUR**", "",
              "## Not an expense", "",
              "Security deposit for 14 Linden Row, Apartment 3B: 3,540.00 EUR, paid on 15 April 2025 "
              "(reference DEP-2025-0388). It is refundable when the lease ends.", ""]
    return "\n".join(lines)


# path, modified (YYYY-MM-DD HH:MM), pdf attributes or None, body
DOCS = [
    # Home
    ("Home/apartment-lease.pdf", "2025-04-12 18:20",
     dict(title="Residential Lease Agreement, 14 Linden Row, Apartment 3B", author="Linden Row Properties Ltd.",
          subject="Lease for Apartment 3B from 1 May 2025", keywords="lease, rent, deposit, notice period, landlord"),
     d("""
     # Residential Lease Agreement
     Lease reference LR-3B-2025

     ## Parties
     Landlord: Linden Row Properties Ltd., 2 Market Lane, Harborview.
     Property manager and contact: Maria Okafor, phone +00 555 0142, lettings@lindenrow.example.
     Tenant: Alex Morgan.

     ## Property
     14 Linden Row, Apartment 3B, Harborview. Two rooms, kitchen, bathroom, balcony, cellar compartment no. 7.

     ## Term
     The lease starts on 1 May 2025 and runs for an indefinite period.

     ## Rent and service charges
     Monthly rent: 1,180.00 EUR. Service charges paid in advance: 210.00 EUR per month (heating, water, building
     cleaning, waste). The total of 1,390.00 EUR is due by the third working day of each month.
     The landlord settles the service charges once a year and sends the statement by 31 December.

     ## Security deposit
     The security deposit is 3,540.00 EUR, three months' rent. The tenant paid it on 15 April 2025
     (reference DEP-2025-0388). The landlord keeps it in a separate deposit account and returns it with interest
     within six months after the tenant moves out, less any proven claims.

     ## Notice period
     The tenant may end the lease with three months' notice to the end of a calendar month, in writing.
     The landlord's notice period follows the statutory rules.

     ## Pets and subletting
     Small pets are allowed. Dogs and cats need the landlord's written consent. Subletting needs written consent.

     ## Repairs
     Report defects to the property manager without delay. Small repairs up to 100.00 EUR per case are paid
     by the tenant, at most 400.00 EUR per year.

     Signed in Harborview on 10 April 2025.
     """)),
    ("Home/renters-insurance-policy.pdf", "2026-04-20 09:05",
     dict(title="Home Contents Insurance Policy NWM-HC-48213907", author="Northwind Mutual Insurance",
          subject="Home contents cover for 14 Linden Row, Apartment 3B, 2026 to 2027",
          keywords="insurance, renters insurance, home contents, bicycle, deductible, claims"),
     d("""
     # Home Contents Insurance Policy
     Northwind Mutual Insurance. Policy number NWM-HC-48213907.

     ## Policyholder and address
     Alex Morgan, 14 Linden Row, Apartment 3B, Harborview.

     ## Policy period
     1 May 2026 to 30 April 2027. The policy renews for one year unless cancelled one month before it ends.

     ## Cover
     Sum insured: 45,000.00 EUR for household contents, at replacement value.
     Covered: fire, water damage from pipes, storm and hail, burglary, vandalism after a burglary.
     Bicycles: covered against theft up to 1,500.00 EUR, also outside the home, if locked to a fixed object.
     Glass breakage: not included.

     ## Deductible
     150.00 EUR per claim.

     ## Premium
     168.00 EUR per year, paid annually on 1 May by direct debit.

     ## Claims
     Report a claim within 7 days: claims hotline 0800 555 0199 or claims@northwind.example.
     Report burglary and bicycle theft to the police as well and keep the police report number.
     """)),
    ("Home/washing-machine-warranty.pdf", "2025-06-05 19:40",
     dict(title="Warranty Card Aquella WM-8400", author="Aquella Home Appliances",
          subject="Manufacturer warranty and extended warranty for the washing machine",
          keywords="warranty, washing machine, serial number, service, Brightline Electronics"),
     d("""
     # Warranty Card
     Aquella WM-8400 front-loading washing machine, 8 kg, 1400 rpm.

     ## Product
     Serial number: AQ84-22-907153.
     Purchased on 3 June 2025 at Brightline Electronics, Harborview Docks, receipt BL-55-118740.
     Price: 649.00 EUR. Delivered and installed on 5 June 2025.

     ## Warranty
     Manufacturer warranty: 2 years from the date of purchase, until 3 June 2027.
     Extended warranty from Brightline Electronics: 3 more years, until 3 June 2030, reference EXT-55120.
     Covered: parts and labour for manufacturing defects. Not covered: damage from limescale, foreign objects in the
     drain pump, or incorrect installation.

     ## Service
     Aquella service line 0800 555 0177. Have the serial number and the receipt ready.
     """)),
    ("Home/washing-machine-quick-guide.md", "2025-06-06 21:10", None,
     d("""
     # Aquella WM-8400 quick guide

     ## Programs
     - **Cotton 40/60**: everyday laundry, 2 h 50 min at 60 °C.
     - **Quick 30**: lightly soiled, up to 3 kg, 30 min.
     - **Wool / hand wash**: 30 °C, 800 rpm.
     - **Drum clean**: 90 °C, empty drum, once a month.

     ## Error codes
     - **E10**: no water. Check that the tap is open and the inlet hose is not kinked.
     - **E21**: water does not drain. Clean the drain pump filter behind the small flap at the bottom right.
       Put a flat tray under it first; about 0.5 l of water comes out.
     - **E40**: door not closed. Press the door until it clicks.

     ## Care
     Clean the detergent drawer every two months. Leave the door open after washing so the seal can dry.
     """)),
    ("Home/coffee-machine-manual.txt", "2025-05-02 10:15", None,
     d("""
     Kettleby Barista Pro 2 espresso machine, user notes

     Bought on 12 November 2024. Warranty 2 years, until 12 November 2026.

     Descaling
     Descale every 300 cups, or when the orange descale light blinks.
     1. Empty the drip tray and remove the water filter.
     2. Fill the tank with 500 ml water and 100 ml Kettleby descaler.
     3. Hold the one-cup and two-cup buttons together for 5 seconds. The program takes about 25 minutes.
     4. Rinse the tank and run one full tank of clean water through the machine.

     Water filter
     Replace the filter every 2 months. Set the water hardness to level 3.

     Grinder
     Grind setting 4 for espresso, 6 for lungo. Do not grind oily beans finer than 3.
     """)),
    ("Home/router-setup.txt", "2025-05-03 16:45", None,
     d("""
     Fibrelink Home router FX-3000, setup notes

     Installed on 3 May 2025 by Fibrelink. Customer number FL-7730215. Plan: Fibre 500 (500/100 Mbit/s).

     Admin page: http://192.168.1.1 (admin password is on the sticker under the router).
     Main Wi-Fi: LindenRow-3B, 2.4 GHz and 5 GHz combined. Password on the sticker.
     Guest Wi-Fi: LindenRow-Guest, enabled, isolated from the main network.

     If the internet light is red: restart the router, wait 3 minutes. If it stays red, check the fibre cable
     in the wall box. Support line 0800 555 0123, open 8:00 to 22:00.

     Firmware updates install automatically at 3:00.
     """)),
    ("Home/move-in-checklist.md", "2025-05-01 20:30", None,
     d("""
     # Move-in checklist, 14 Linden Row 3B

     Handover with Maria Okafor on 30 April 2025 at 17:00.

     ## Meter readings at handover
     - Electricity: 48,213 kWh (meter no. 1EMH-0041187)
     - Water: 312.4 m³

     ## Keys received
     - 2 apartment keys
     - 1 mailbox key
     - 1 cellar key (compartment 7)

     ## Defects noted in the handover report
     - Scratch on the kitchen worktop, left of the sink
     - Cracked tile in the bathroom behind the door
     - Balcony door handle loose

     ## To do
     - [x] Register electricity with Brightwatt Energy
     - [x] Internet installation (Fibrelink, 3 May)
     - [x] Change address with the bank and insurance
     - [ ] Ask the landlord to fix the balcony door handle
     """)),
    # Travel
    ("Travel/flight-booking-lisbon.pdf", "2026-08-28 22:14",
     dict(title="Booking Confirmation K7QM2P", author="Skyward Air",
          subject="Flights Harborview to Lisbon, 14 to 21 November 2026",
          keywords="flight, booking, Lisbon, baggage, seats, Skyward Air"),
     d("""
     # Booking Confirmation
     Skyward Air. Booking code K7QM2P. Booked on 28 August 2026.

     Passenger: Alex Morgan.

     ## Outbound
     SW 1432, Saturday 14 November 2026.
     Harborview (HBV) 07:40, Lisbon (LIS) 10:15. Seat 14C.

     ## Return
     SW 1437, Saturday 21 November 2026.
     Lisbon (LIS) 18:05, Harborview (HBV) 22:30. Seat 9A.

     ## Baggage
     1 cabin bag, 8 kg, 55 x 40 x 23 cm.
     1 checked bag, 23 kg, included.

     ## Price
     Fares 254.80 EUR, checked bag 2 x 29.00 EUR. Total paid: 312.80 EUR.

     Online check-in opens 30 hours before departure. Bag drop closes 45 minutes before departure.
     """)),
    ("Travel/hotel-booking-lisbon.pdf", "2026-08-29 08:31",
     dict(title="Reservation HZ-90417, Casa Azulejo Hotel", author="Casa Azulejo Hotel",
          subject="Hotel in Lisbon, 14 to 21 November 2026",
          keywords="hotel, Lisbon, reservation, check-in, cancellation"),
     d("""
     # Reservation Confirmation
     Casa Azulejo Hotel, Rua do Vento Norte 27, Lisbon. Confirmation number HZ-90417.

     Guest: Alex Morgan.

     ## Stay
     Check-in: Saturday 14 November 2026, from 15:00.
     Check-out: Saturday 21 November 2026, until 11:00.
     7 nights, one double room with balcony, breakfast included.

     ## Price
     128.00 EUR per night. Total 896.00 EUR, paid at the hotel.

     ## Cancellation
     Free cancellation until 7 November 2026, 18:00 local time. After that the first night is charged.

     Luggage storage is free on the day of departure. Reception is open 24 hours.
     """)),
    ("Travel/train-ticket-port-ellis.pdf", "2026-09-21 12:02",
     dict(title="E-Ticket 4471-0920-6638", author="Coastline Rail",
          subject="Harborview Central to Port Ellis and back, 3 to 5 October 2026",
          keywords="train, ticket, Port Ellis, seat reservation, Coastline Rail"),
     d("""
     # E-Ticket
     Coastline Rail. Ticket number 4471-0920-6638. Passenger: Alex Morgan.

     ## Outbound
     Saturday 3 October 2026. Harborview Central 08:12, Port Ellis 10:47.
     Train CR 518, coach 7, seat 64.

     ## Return
     Monday 5 October 2026. Port Ellis 17:30, Harborview Central 20:04.
     Train CR 531, coach 4, seat 22.

     ## Price
     2 x 39.90 EUR. Total 79.80 EUR, paid by card.

     Valid only with the booked trains. Show this ticket and an ID on request.
     """)),
    ("Travel/lisbon-itinerary.md", "2026-09-30 21:48", None,
     d("""
     # Lisbon, 14 to 21 November 2026

     Flight SW 1432 lands at 10:15. Metro red line from the airport to Alameda, then green line to the hotel.
     Hotel check-in from 15:00 (Casa Azulejo, confirmation HZ-90417), drop bags earlier.

     ## Plan
     - **Sat 14**: arrive, walk through Alfama, dinner near the hotel.
     - **Sun 15**: tram 28 early (before 9:00), castle, Miradouro da Graça at sunset.
     - **Mon 16**: tile museum, LX Factory in the afternoon.
     - **Tue 17**: Belém: monastery, tower, pastries.
     - **Wed 18**: free day, maybe a cooking class.
     - **Thu 19**: day trip to Sintra, train from Rossio at 9:11, back by 18:00.
     - **Fri 20**: Cascais by train, beach walk.
     - **Sat 21**: check-out 11:00, flight SW 1437 at 18:05. Leave the hotel at 15:30.

     Budget: about 60 EUR a day for food and transport.
     """)),
    ("Travel/passport-renewal-checklist.md", "2026-09-15 19:20", None,
     d("""
     # Passport renewal checklist

     Current passport expires on **2 March 2027**. Renew now so it is valid for trips next spring.
     The Lisbon trip in November works with the current passport.

     ## Appointment
     Harborview Civic Office, citizen services, desk 4.
     Thursday **22 October 2026 at 10:30**. Booking reference CO-2026-55781.

     ## Bring
     - [ ] Old passport
     - [ ] One biometric photo, 35 x 45 mm, not older than 6 months
     - [ ] Completed application form (printed, not signed)
     - [ ] Fee: 82.00 EUR, card or cash

     ## After the appointment
     Processing takes about 4 weeks. Pick-up in person with the collection letter; the old passport is
     invalidated at pick-up.
     """)),
    # Money
    ("Money/electricity-bill-2026-08.pdf", "2026-09-17 07:58",
     dict(title="Invoice BW-2026-0917-3341", author="Brightwatt Energy",
          subject="Electricity bill for August 2026", keywords="electricity, invoice, bill, kWh, Brightwatt"),
     d("""
     # Electricity Invoice
     Brightwatt Energy. Invoice number BW-2026-0917-3341, issued 17 September 2026.

     Customer: Alex Morgan, customer number 7720-4410.
     Supply address: 14 Linden Row, Apartment 3B, Harborview. Meter no. 1EMH-0041187.

     ## Billing period
     1 August 2026 to 31 August 2026.
     Meter reading 31 July: 50,485 kWh. Meter reading 31 August: 50,671 kWh.

     ## Charges
     Consumption: 186 kWh x 0.31 EUR = 57.66 EUR.
     Standing charge: 11.50 EUR.
     Total due: 69.16 EUR.

     Due on 25 September 2026, paid by direct debit.
     """)),
    ("Money/internet-bill-2026-09.pdf", "2026-09-02 06:40",
     dict(title="Invoice FL-INV-2026-09-88213", author="Fibrelink",
          subject="Internet bill for September 2026", keywords="internet, invoice, bill, fibre, Fibrelink"),
     d("""
     # Invoice
     Fibrelink. Invoice number FL-INV-2026-09-88213, issued 2 September 2026.

     Customer number FL-7730215. Alex Morgan, 14 Linden Row, Apartment 3B, Harborview.

     ## September 2026
     Fibre 500 plan (500/100 Mbit/s): 44.99 EUR.
     Router FX-3000 rental: included.
     Total: 44.99 EUR.

     Paid by direct debit on 15 September 2026. Minimum term ended on 2 May 2026; the plan now renews monthly
     with one month's notice.
     """)),
    ("Money/laptop-receipt.pdf", "2026-02-18 15:22",
     dict(title="Receipt BL-55-209381", author="Brightline Electronics",
          subject="Corvex Book 14 Pro laptop, 18 February 2026",
          keywords="receipt, laptop, warranty, serial number, Brightline Electronics"),
     d("""
     # Receipt
     Brightline Electronics, Harborview Docks. Receipt number BL-55-209381.
     Wednesday 18 February 2026, 15:20.

     ## Items
     Corvex Book 14 Pro laptop, 16 GB RAM, 1 TB SSD, space grey: 1,349.00 EUR.
     Serial number CX14-7F3K-22918.
     Laptop sleeve 14 inch: 29.00 EUR.
     CarePlus protection, 3 years (accidental damage, until 18 February 2029): 149.00 EUR.

     Total: 1,527.00 EUR, paid by card.

     Returns within 30 days with this receipt. Manufacturer warranty 2 years.
     """)),
    ("Money/expenses-2025.md", "2026-01-14 20:05", None, expenses_summary()),
    # Health
    ("Health/vaccination-record.pdf", "2025-10-21 11:30",
     dict(title="Vaccination Record, Alex Morgan", author="Harborview Family Practice",
          subject="Vaccinations given and next due dates",
          keywords="vaccination, booster, tetanus, influenza, hepatitis"),
     d("""
     # Vaccination Record
     Harborview Family Practice, Dr. Lena Brooks. Patient: Alex Morgan.

     ## Given
     Tetanus, diphtheria, pertussis (booster): 12 March 2021. Next booster due March 2031.
     Hepatitis A, dose 1: 2 September 2024.
     Hepatitis A, dose 2: 4 March 2025. Course complete.
     Influenza, season 2025/26: 21 October 2025.
     COVID-19 booster: 21 October 2025.

     ## Recommended next
     Influenza for season 2026/27 in October or November 2026.
     """)),
    ("Health/dentist-appointment.txt", "2026-09-24 13:10", None,
     d("""
     Bright Smile Dental, appointment confirmation

     Check-up and professional cleaning with Dr. Omar Haddad.
     Thursday 29 October 2026 at 08:45, about 45 minutes.
     14 Quay Street, 2nd floor, Harborview. Phone +00 555 0161.

     Cleaning costs 85.00 EUR, paid at the practice.
     Cancel at least 24 hours before, otherwise a 35.00 EUR fee is charged.
     """)),
    ("Health/prescription-cetirizine.pdf", "2026-09-02 10:48",
     dict(title="Prescription RX-26-114092", author="Harborview Family Practice",
          subject="Cetirizine for hay fever, 2 September 2026", keywords="prescription, medication, allergy, refill"),
     d("""
     # Prescription
     Harborview Family Practice, Dr. Lena Brooks. Prescription number RX-26-114092.
     Issued 2 September 2026 for Alex Morgan.

     ## Medication
     Cetirizine 10 mg tablets, 30 tablets.
     Take one tablet daily in the evening while hay fever symptoms last.
     Refills: 1. Valid until 2 December 2026.

     May cause drowsiness. Avoid alcohol.
     """)),
    ("Health/gym-membership-contract.pdf", "2025-01-02 18:00",
     dict(title="Membership Contract PF-20419", author="Pulse Fitness Club",
          subject="Gym membership, Harborview Docks branch", keywords="gym, membership, contract, cancellation, fee"),
     d("""
     # Membership Contract
     Pulse Fitness Club, Harborview Docks branch. Membership number PF-20419. Member: Alex Morgan.

     ## Term
     Start: 1 January 2025. Minimum term 12 months, then monthly.

     ## Fees
     Monthly fee: 39.90 EUR, by direct debit on the 1st of each month.
     One-time joining fee: 19.00 EUR.

     ## Cancellation
     After the minimum term, cancel with 4 weeks' notice to the end of a month, in writing or at the front desk.

     ## Pause
     The membership can be paused for up to 3 months per year for medical reasons, with a doctor's note.

     Opening hours: Monday to Friday 6:00 to 23:00, weekends 8:00 to 20:00.
     """)),
    # Work
    ("Work/q4-planning-meeting-notes.md", "2026-09-30 17:35", None,
     d("""
     # Q4 planning, Northbeam Studio

     30 September 2026, 14:00 to 15:30. Attendees: Priya Nair (project lead), Tom Lindqvist, Dana Reyes,
     Alex Morgan.

     ## Decisions
     - Fieldnote 2.3 launch moves from 5 November to **12 November 2026**. The release candidate is due
       5 November instead.
     - Offline sync is the headline feature. Shared notebooks move to 2.4.
     - User research budget of **24,000 EUR** approved for Q4.

     ## Action items
     - Priya: confirm the research budget with finance by 7 October.
     - Dana: beta invite list of 500 testers by 20 October.
     - Tom: first draft of the release notes by 2 November.
     - Alex: book usability sessions with 6 participants for the week of 12 October.

     Next meeting: 14 October, 14:00.
     """)),
    ("Work/fieldnote-2.3-project-plan.pdf", "2026-09-18 16:05",
     dict(title="Project Plan: Fieldnote 2.3 Offline Sync", author="Northbeam Studio",
          subject="Milestones, budget and risks for Fieldnote 2.3",
          keywords="project plan, milestones, budget, risks, Fieldnote, offline sync"),
     d("""
     # Project Plan: Fieldnote 2.3 Offline Sync
     Northbeam Studio. Project lead: Priya Nair. Version 3, 18 September 2026.

     ## Goal
     Fieldnote works fully offline and syncs changes when the connection returns, without data loss.

     ## Milestones
     Kickoff: 1 September 2026.
     Design freeze: 9 October 2026.
     Public beta: 23 October 2026.
     Release candidate: 5 November 2026.
     Launch: 12 November 2026.

     ## Budget
     Engineering: 58,000 EUR. User research: 24,000 EUR. QA and device lab: 4,500 EUR.
     Total: 86,500 EUR.

     ## Team
     Priya Nair (lead), Tom Lindqvist (sync engine), Dana Reyes (beta program), Alex Morgan (design and research).

     ## Risks
     1. Conflict resolution for notes edited on two devices. Mitigation: field-level merge, tested in beta.
     2. Battery use of background sync. Mitigation: batch uploads, measured on the device lab.
     3. Beta feedback arrives late. Mitigation: usability sessions in the week of 12 October.
     """)),
    ("Work/team-offsite-port-ellis.md", "2026-09-22 09:12", None,
     d("""
     # Team offsite, Port Ellis

     3 to 5 October 2026 at Seaglass Lodge, 2 Shoreline Path, Port Ellis.
     Travel by train: CR 518 from Harborview Central at 08:12 on Saturday, back on Monday with CR 531 at 17:30.

     ## Agenda
     - **Sat**: arrival, lunch, Fieldnote 2.3 retro so far, beach walk.
     - **Sun**: 2024 to 2026 roadmap review, workshop on offline sync conflict cases, team dinner at 19:30.
     - **Mon**: priorities for Q1, wrap-up by 15:00.

     Rooms are booked and paid by Northbeam Studio. Bring a laptop and walking shoes.
     """)),
    # Recipes
    ("Recipes/banana-bread.md", "2025-03-09 15:40", None,
     d("""
     # Banana bread

     One loaf tin (25 cm). Prep 15 minutes, bake 55 to 60 minutes at 180 °C.

     ## Ingredients
     - 3 very ripe bananas
     - 75 g melted butter
     - 150 g brown sugar
     - 1 egg
     - 1 tsp vanilla extract
     - 1 tsp baking soda
     - a pinch of salt
     - 190 g flour
     - optional: 60 g chopped walnuts

     ## Method
     1. Mash the bananas, stir in the butter.
     2. Mix in sugar, egg and vanilla.
     3. Sprinkle baking soda and salt over it, then fold in the flour (and walnuts).
     4. Pour into the lined tin and bake until a skewer comes out clean.

     Keeps 3 days wrapped, or freeze in slices.
     """)),
    ("Recipes/chickpea-spinach-curry.md", "2025-11-23 19:15", None,
     d("""
     # Chickpea and spinach curry

     Serves 4. Ready in 35 minutes. Vegan.

     ## Ingredients
     - 2 cans chickpeas (400 g each), drained
     - 400 ml coconut milk
     - 400 g chopped tomatoes
     - 200 g fresh spinach
     - 1 onion, 3 garlic cloves, a thumb of ginger
     - 2 tsp garam masala, 1 tsp ground cumin, 1 tsp turmeric, chili to taste
     - juice of half a lime, fresh coriander

     ## Method
     1. Fry the onion 8 minutes, add garlic and ginger for 1 minute.
     2. Add the spices, stir 30 seconds.
     3. Add tomatoes, coconut milk and chickpeas. Simmer 15 minutes.
     4. Stir in the spinach until it wilts. Finish with lime and coriander.

     Serve with rice or flatbread.
     """)),
    ("Recipes/sourdough-starter.txt", "2026-01-10 08:25", None,
     d("""
     Sourdough starter notes

     Started on 2 January 2026 with rye flour. Name on the jar: Bubbles.

     Feeding at room temperature: every 12 hours, 1:1:1.
     Keep 50 g starter, add 50 g flour (half rye, half wheat) and 50 g water at 26 °C.

     In the fridge: feed once a week. Take it out the evening before baking and feed twice.
     Ready when it doubles within 4 to 6 hours and a spoonful floats.
     """)),
    # Car
    ("Car/car-service-record.pdf", "2026-03-12 17:50",
     dict(title="Service Invoice RA-2026-0312-17", author="Riverside Auto Service",
          subject="Annual service of the Velora Hatch, 12 March 2026",
          keywords="car, service, oil change, brake fluid, invoice, Riverside Auto"),
     d("""
     # Service Invoice
     Riverside Auto Service, 40 Mill Road, Harborview. Invoice RA-2026-0312-17, 12 March 2026.

     ## Vehicle
     Velora Hatch 1.4, 2019. Registration HB-482-KT. Mileage at service: 61,240 km.

     ## Work done
     Engine oil 5W-30, 4.5 l: 72.00 EUR.
     Oil filter: 14.50 EUR.
     Cabin air filter: 28.00 EUR.
     Brake fluid change: 65.00 EUR.
     Labour, 2.5 h x 84.00 EUR: 210.00 EUR.
     Total: 389.50 EUR, paid by card.

     ## Findings
     Front brake pads at 40 percent. Check again at the next tire change.
     Rear tires 4 mm tread.

     ## Next service
     Due at 76,000 km or in March 2027, whichever comes first.
     """)),
    ("Car/tire-change.txt", "2026-04-11 12:30", None,
     d("""
     Tire changes, Velora Hatch (HB-482-KT), Riverside Auto

     8 November 2025: winter tires on, at 57,480 km. Summer tires stored at Riverside Auto,
     storage ticket TS-1187. Fitting 35.00 EUR, storage for the season 25.00 EUR.

     11 April 2026: summer tires back on, at 61,920 km. Fitting 35.00 EUR.
     Winter tires now in storage under ticket TS-1187, tread 5.5 mm, good for another season.

     Next change to winter tires: book for early November 2026.
     """)),
    ("Car/car-insurance-card.txt", "2026-01-05 09:00", None,
     d("""
     Motor insurance card

     Northwind Mutual Insurance, motor policy NWM-MO-30917.
     Vehicle: Velora Hatch 1.4, registration HB-482-KT.
     Cover: third party and partial cover, deductible 300.00 EUR.
     Premium: 540.00 EUR per year, renews on 1 January.

     Roadside assistance, 24 hours: 0800 555 0150.
     After an accident: photograph both cars, note the other driver's registration and insurer,
     call the claims line 0800 555 0199 within 7 days.
     """)),
]


# Apple Notes for the dev seed route. title, created, modified, text. Each answers a demo question alone or with a document.
NOTES = [
    ("Lisbon packing list", "2026-09-02T20:10:00Z", "2026-10-05T19:42:00Z", d("""
     Lisbon packing list
     Flight SW 1432 on Sat 14 Nov at 07:40, booking K7QM2P. Leave home at 05:45.
     One checked bag up to 23 kg plus the cabin bag, so the big suitcase is fine.
     - ID card and passport (passport valid until March 2027)
     - Phone charger, power bank, EU plug adapter not needed
     - Rain jacket, light sweater, comfortable shoes for the hills
     - Swimwear for Cascais
     - Printed hotel confirmation HZ-90417
     Still to buy: travel-size sunscreen, a small day backpack.
     """)),
    ("Fieldnote 2.3 follow-ups", "2026-09-30T15:40:00Z", "2026-10-01T08:15:00Z", d("""
     Fieldnote 2.3 follow-ups after the Q4 planning meeting
     My part: book usability sessions with 6 participants for the week of 12 October, before the beta on 23 October.
     Draft the session script by 9 October (design freeze day).
     Ask Priya whether the 24,000 EUR research budget covers participant vouchers (6 x 50 EUR).
     Remind Tom that the release notes draft is due 2 November, three days before the release candidate.
     """)),
    ("Car service reminder", "2026-09-20T09:00:00Z", "2026-10-04T18:20:00Z", d("""
     Car service reminder
     Odometer on 4 October: 68,950 km. Next service is due at 76,000 km or March 2027.
     Book the winter tire change at Riverside Auto for early November, ticket TS-1187.
     Ask them to check the front brake pads then (40 percent at the March service).
     """)),
    ("Guest Wi-Fi", "2026-05-10T12:00:00Z", "2026-05-10T12:05:00Z", d("""
     Guest Wi-Fi
     Network: LindenRow-Guest
     Password: harbor-lantern-58
     Isolated from the main network. Change it after the summer visitors leave.
     """)),
    ("Gift ideas", "2026-08-15T21:30:00Z", "2026-09-28T20:05:00Z", d("""
     Gift ideas
     Sam, birthday 2 December: ceramic pour-over coffee set, or a voucher for the bookshop on Quay Street.
     Jo, housewarming in October: a good olive oil from Lisbon? Too late, the trip is in November. A plant instead.
     Parents, anniversary in January: weekend in Port Ellis, Seaglass Lodge was lovely.
     """)),
    ("Books to read", "2026-06-01T19:00:00Z", "2026-09-12T22:10:00Z", d("""
     Books to read
     - The Left Hand of Darkness, Ursula K. Le Guin
     - Piranesi, Susanna Clarke
     - The Book of Disquiet, Fernando Pessoa (for Lisbon)
     - Thinking in Systems, Donella Meadows
     Finished this year: Project Hail Mary, The Remains of the Day.
     """)),
    ("Shopping list", "2026-10-06T17:00:00Z", "2026-10-07T18:30:00Z", d("""
     Shopping list
     - 3 bananas, let them get very ripe for banana bread
     - 2 cans chickpeas, coconut milk, fresh spinach, coriander, a lime (curry on Thursday)
     - Kettleby descaler, the orange light is blinking
     - Rye flour for the starter
     - Dishwasher tabs
     """)),
    ("Offline mode (first sketch)", "2026-09-08T08:30:00Z", "2026-09-08T09:05:00Z", d("""
     Offline mode (first sketch)
     Idea for Fieldnote: everything works on the plane, edits queue up locally and sync when the network is back.
     Show a small cloud icon with a count of unsynced notes. No modal errors when offline.
     Question for Tom: can the sync engine keep a per-field change log?
     """)),
    ("Offline mode (conflict cases)", "2026-09-19T16:10:00Z", "2026-09-19T16:45:00Z", d("""
     Offline mode (conflict cases)
     Same note edited on phone and laptop while both offline: merge per field, title and body separately.
     Same paragraph edited twice: keep both versions and mark the note "needs review".
     Note deleted on one device, edited on the other: the edit wins, deletion is undone.
     """)),
    ("Offline mode (battery test)", "2026-09-29T11:00:00Z", "2026-09-29T11:20:00Z", d("""
     Offline mode (battery test)
     Device lab result: background sync every 5 minutes costs about 4 percent battery per day.
     Batching uploads to every 15 minutes brings it under 1.5 percent. Go with 15 minutes, sync immediately on open.
     """)),
    ("Offline mode (usability takeaways)", "2026-10-07T17:30:00Z", "2026-10-07T18:05:00Z", d("""
     Offline mode (usability takeaways)
     Pilot session before the real ones next week. People did not notice the cloud icon at all.
     Better: a one-line banner "Offline, 3 notes will sync later" that disappears when synced.
     Everyone expected the conflict "needs review" badge in the note list, not only inside the note.
     Bring both changes to the design freeze on 9 October.
     """)),
    ("Health to-dos", "2026-09-24T13:20:00Z", "2026-10-02T07:50:00Z", d("""
     Health to-dos
     - Dentist on Thu 29 Oct at 08:45, Bright Smile Dental. Cancel 24 h before if needed.
     - Flu shot: last one was 21 Oct 2025, book for late October at the family practice.
     - Use the one cetirizine refill before 2 December.
     - Gym: pause is possible for 3 months with a doctor's note, not needed now.
     """)),
]


# Neutral photos rendered as images: name, size, background, body. Added to Photos once with simctl addmedia.
IMAGES_SPEC = [
    ("boarding-pass-copenhagen.png", (1179, 2556), [0.93, 0.95, 0.99], 3.2, d("""
     # Skyward Air
     ## Boarding pass

     MORGAN / ALEX

     Harborview HBV  to  Copenhagen CPH
     Flight SW 1208
     Monday 22 June 2026

     Boarding 06:55    Departure 07:25
     Gate B12    Seat 21A    Group 3

     Booking code R4TX9B
     Cabin bag only
     """)),
    ("receipt-harbor-market.png", (1080, 1920), [0.99, 0.98, 0.95], 2.8, d("""
     # HARBOR MARKET
     12 Quay Street, Harborview
     04.10.2026  18:42  Till 3

     Bananas 1.2 kg            2.39
     Chickpeas 400 g x2        1.98
     Coconut milk 400 ml       1.79
     Spinach 200 g             2.49
     Rye flour 1 kg            2.29
     Olive oil 0.75 l          8.99
     Coffee beans 1 kg        16.90
     Dishwasher tabs           1.64

     TOTAL EUR                38.47
     Card payment             38.47

     Thank you for shopping with us
     """)),
    ("whiteboard-fieldnote-timeline.png", (1600, 1200), [0.97, 0.97, 0.96], 3.0, d("""
     # Fieldnote 2.3 timeline
     Design freeze  9 Oct
     Usability sessions  week of 12 Oct
     Public beta  23 Oct  (500 testers)
     Release candidate  5 Nov
     LAUNCH  12 Nov

     Risks: conflict merge, battery, late feedback
     """)),
]


def reflow(body):
    """Joins source-wrapped lines so a PDF paragraph breaks only where a sentence or field ends."""
    out = []
    for line in body.split("\n"):
        prev = out[-1] if out else ""
        if prev and line and not prev.startswith("#") and not line.startswith(("#", "- ")) and prev[-1] not in ".:)":
            out[-1] = f"{prev} {line}"
        else:
            out.append(line)
    return "\n".join(out)


def stamp(path, when):
    t = time.mktime(datetime.strptime(when, "%Y-%m-%d %H:%M").timetuple())
    os.utime(path, (t, t))


def build():
    # Kept between runs: a PDF embeds its creation time, so it is re-rendered only when its spec changes.
    wanted = {OUT / rel for rel, _, _, _ in DOCS}
    for stale in [p for p in OUT.rglob("*") if p.is_file() and p not in wanted and p.suffix != ".spec"]:
        stale.unlink()
    pdfs = []
    for rel, when, attrs, body in DOCS:
        path = OUT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if attrs:
            spec = dict(out=str(path), kind="pdf", body=reflow(body), **attrs)
            key = path.with_suffix(".spec")
            if not path.exists() or not key.exists() or key.read_text() != json.dumps(spec):
                pdfs.append(spec)
                key.write_text(json.dumps(spec))
        else:
            path.write_text(body, encoding="utf-8")
    if pdfs:
        subprocess.run([str(HERE / "render")], input=json.dumps(pdfs).encode(), check=True)
    for rel, when, _, _ in DOCS:
        stamp(OUT / rel, when)
    NOTES_JSON.write_text(json.dumps(
        [dict(title=t, created=c, modified=m, text=x) for t, c, m, x in NOTES], indent=2), encoding="utf-8")
    IMAGES.mkdir(exist_ok=True)
    subprocess.run([str(HERE / "render")], input=json.dumps([
        dict(out=str(IMAGES / name), kind="png", width=w, height=h, background=bg, scale=scale, body=body)
        for name, (w, h), bg, scale, body in IMAGES_SPEC]).encode(), check=True)
    print(f"built {len(DOCS)} documents ({len(pdfs)} PDFs rendered), {len(NOTES)} notes, {len(IMAGES_SPEC)} images")


def on_my_iphone():
    for meta in (SIM_DATA / "Containers/Shared/AppGroup").glob("*/.com.apple.mobile_container_manager.metadata.plist"):
        ident = subprocess.run(["/usr/libexec/PlistBuddy", "-c", "Print :MCMMetadataIdentifier", str(meta)],
                               capture_output=True, text=True).stdout.strip()
        if ident == "group.com.apple.FileProvider.LocalStorage":
            return meta.parent / "File Provider Storage"
    sys.exit("On My iPhone storage not found")


def sync():
    target = on_my_iphone()
    strays = [p for p in target.iterdir() if not p.name.startswith(".") and p.name not in MANAGED]
    if strays:
        backup = HERE / f"backup-{datetime.now():%Y%m%d-%H%M%S}"
        backup.mkdir()
        for p in strays:
            shutil.move(str(p), backup / p.name)
        print(f"moved {[p.name for p in strays]} to {backup}")
    subprocess.run(["rsync", "-a", "--checksum", "--delete", "--exclude", ".*", "--exclude", "*.spec", "--itemize-changes",
                    f"{OUT}/", f"{target}/"], check=True)
    print(f"synced into {target}")


def add_photos():
    marker = HERE / ".photos-added"
    if marker.exists():
        print("photos already added")
        return
    subprocess.run(["xcrun", "simctl", "addmedia", DEVICE, *map(str, sorted(IMAGES.glob("*.png")))], check=True)
    marker.touch()
    print("added photos")


if __name__ == "__main__":
    build()
    if "--no-sync" not in sys.argv:
        sync()
    if "--photos" in sys.argv:
        add_photos()
