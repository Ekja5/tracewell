# What to bring to the pilot session

Three exports you already produce. Excel (.xlsx) or CSV. Your own column names are fine: we map them once and
the mapping is remembered. Remove patient names and record numbers; none are needed.

## 1. Inventory balances (one row per item, lot and location)

| Column | Required | Notes |
|---|---|---|
| Location | Yes | Warehouse, consignment location or hospital name, as you write it |
| Manufacturer | Yes* | *Needed for any new item, and whenever two manufacturers share a catalog number |
| Catalog number | Yes | Format the column as **Text** so leading zeros survive (00417, not 417) |
| Description | No | Used the first time an item is seen |
| Lot **or** Serial | Yes | Rows with neither are held for review |
| Expiry date | No | YYYY-MM-DD or MM/DD/YYYY |
| Quantity on hand | Yes | Whole number |
| Unit of measure | No | EA assumed. Boxes/packs are fine; you confirm units per box once |
| Units per box | No | If your system has it |

Also tell us: **when the file was exported**, **which locations it covers**, and whether it lists **everything**
at those locations or only part.

Bring **two** exports taken at different times (for example yesterday and this morning). The second one is what
shows how differences are handled.

## 2. Case schedule (one row per case, next 3 to 5 days)

| Column | Required | Notes |
|---|---|---|
| Case ID | Yes | Your scheduling reference. Not a patient identifier |
| Facility | Yes | Hospital or surgery center name |
| Surgery date | Yes | In the facility's local calendar |
| Start time | Yes | Local time at the facility (7:30 AM or 07:30) |
| Procedure, Surgeon, Rep | No | Surgeon as a code or name; rep name helps assign an owner |
| Status | No | "Cancelled" cancels the case |

## 3. Case requirements (one row per case and item)

| Column | Required | Notes |
|---|---|---|
| Case ID | Yes | Must match the schedule |
| Manufacturer | Yes* | Same rule as inventory |
| Catalog number | Yes | Text, exact |
| Quantity required | Yes | Whole number |
| Description, Unit of measure | No | |

## 4. Not files, but needed before the session

- The hospitals in scope, their time zones, receiving hours, and how far ahead each wants implants delivered.
- Who should have a sign-in: coordinator, operations manager, warehouse, courier, and one receiving contact per hospital.
- For five to ten recent cases: what your current process expected, and what actually happened. That is the
  comparison the pilot report is built on.
