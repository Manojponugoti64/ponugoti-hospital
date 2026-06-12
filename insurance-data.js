// Ponugoti Hospital - shared insurance & scheme directory.
// Loaded after config.js. Used by insurance.html and bill-detail.html.
// Edit this file to add/remove schemes and insurers - no other change needed.

window.INSURANCE_DATA = {
  // ---- Government / state schemes ----
  // `empanelled: true` => this hospital is empanelled; `specialties` lists
  // the departments covered under the empanelment.
  stateSchemes: [
    {
      name: "Dr. YSR Aarogyasri (AP)",
      empanelled: true,
      specialties: ["Urology", "Nephrology", "General Medicine"],
      note: "Hospital empanelled - cashless for covered procedures",
    },
    { name: "Ayushman Bharat (PM-JAY)", empanelled: false, specialties: [] },
    { name: "Aarogyasri (Telangana)", empanelled: false, specialties: [] },
    { name: "Employees Health Scheme - EHS (AP)", empanelled: false, specialties: [] },
    { name: "CGHS (Central Government Health Scheme)", empanelled: false, specialties: [] },
    { name: "ESIC (Employees' State Insurance)", empanelled: false, specialties: [] },
    { name: "ECHS (Ex-Servicemen Contributory Health Scheme)", empanelled: false, specialties: [] },
    { name: "Railway Employees Liberalized Health Scheme", empanelled: false, specialties: [] },
  ],

  // ---- Private insurers (IRDAI-registered, health business) ----
  privateInsurers: [
    // Standalone health insurers
    "Star Health & Allied Insurance",
    "Niva Bupa Health Insurance",
    "Care Health Insurance",
    "ManipalCigna Health Insurance",
    "Aditya Birla Health Insurance",
    "Narayana Health Insurance",
    "Galaxy Health Insurance",
    // General insurers with health portfolios
    "ICICI Lombard General Insurance",
    "HDFC ERGO General Insurance",
    "Bajaj Allianz General Insurance",
    "Tata AIG General Insurance",
    "Reliance General Insurance",
    "SBI General Insurance",
    "Future Generali India Insurance",
    "Royal Sundaram General Insurance",
    "Cholamandalam MS General Insurance",
    "IFFCO Tokio General Insurance",
    "Liberty General Insurance",
    "Magma HDI General Insurance",
    "Raheja QBE General Insurance",
    "Shriram General Insurance",
    "Go Digit General Insurance",
    "ACKO General Insurance",
    "Navi General Insurance",
    "Zuno General Insurance (Edelweiss)",
    "Zurich Kotak General Insurance",
    "Universal Sompo General Insurance",
    // Public-sector general insurers
    "The New India Assurance",
    "United India Insurance",
    "National Insurance Company",
    "The Oriental Insurance Company",
    // Life insurers' health riders / group covers
    "LIC of India (Group Health)",
    "Max Life Insurance (Health Riders)",
    "Kotak Mahindra Life (Health Riders)",
  ],

  // ---- Third-party administrators (cashless desks) ----
  tpas: [
    "Medi Assist TPA",
    "MDIndia Health Insurance TPA",
    "Paramount Health Services TPA",
    "Family Health Plan (FHPL) TPA",
    "Vidal Health TPA",
    "Health India Insurance TPA",
    "Raksha Health Insurance TPA",
    "Safeway Insurance TPA",
    "Heritage Health Insurance TPA",
    "Park Mediclaim TPA",
    "Good Health Insurance TPA",
    "East West Assist TPA",
    "Ericson Insurance TPA",
    "Genins India Insurance TPA",
    "Volo Health Insurance TPA (Vipul MedCorp)",
    "Anyuta Medinet Healthcare TPA",
    "Anmol Medicare TPA",
    "Rothshield Healthcare TPA",
    "Dedicated Healthcare Services (DHS) TPA",
    "Grand Insurance TPA",
  ],
};

// Backwards-compatible shape used by bill-detail.html's provider dropdown.
window.INS_PROVIDERS = {
  "Private Insurance": window.INSURANCE_DATA.privateInsurers.concat(
    window.INSURANCE_DATA.tpas.map((t) => t + " (TPA)")
  ),
  "State Scheme": window.INSURANCE_DATA.stateSchemes.map((s) => s.name),
};
