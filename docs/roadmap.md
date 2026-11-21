# Later roadmap (not in the pilot)

The pilot prioritizes a working case-to-cash loop. Each item below should start only when the stated evidence or access exists.

| Item | Customer evidence needed | Integration access needed | Data quality needed |
|---|---|---|---|
| RFID cabinets / smart consignment | Interview data showing consignment count errors or expiries cost more than a cabinet's annual cost at specific hospitals; hospital willingness to host hardware | Cabinet vendor API or event feed, plus hospital network and IT security approval | Tags applied at the unit level with verified GTIN/serial mapping; pilot count accuracy baseline above ~98% so RFID gaps are attributable |
| Predictive demand (par levels, case-mix forecasting) | At least 6–12 months of pilot usage showing recurring shortages or overstock tied to preference cards | Hospital schedule feed (live, with history) | Clean dispositions per case (implanted vs opened-unused vs returned), stable preference-card versions, and complete historical cases without manual gaps |
| OCR of PO documents | Finance time studies showing PO entry or matching is a top time sink, with sample POs from target customers | Access to the PO inbox or procurement network documents | Consistent PO formats per customer; a labeled sample set for accuracy measurement before any automation |
| Live EHR connections | A documented need that schedule feeds cannot meet (for example, intra-op implant documentation), with hospital sponsorship | Hospital interface engine (HL7/FHIR), executed BAA, security review | ePHI handling program in place (see `security-privacy.md`); patient identity matching rules approved by the hospital |
| Cross-region inventory optimization | Multiple regions live, with measured transfer costs and stock-outs across regions | Multi-tenant or multi-region data sharing agreements between distributors or manufacturer | Reliable travel/cost data (not seeded estimates), consistent catalog mapping across regions |
| Verified HIBCC parser | Share of customer labels that are HIBCC | None | A validated library plus real label test vectors |
| SAP / Salesforce adapters | A customer with an approved integration project | Sandbox credentials, mapping sign-off, integration user permissions | Master-data alignment (customer, item, price) between systems |
