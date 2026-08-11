/* ============================================================
   EVER NOVA LIFE — Product Catalog
   8 SKUs · For in-vitro research and laboratory use only
   Each product: id, name, category, categoryName, price,
   originalPrice, purity, quantity, description, specs{},
   coa{}, inStock, badge, featured, lot
   `stockQty` (a live unit count) is deliberately NOT seeded here — it is set in
   admin-products.html and drawn down by orders, so it belongs to the server's
   store, not to git. Absent = untracked/unlimited; see server/products.js.
   coa{} carries the lot's third-party certificate of analysis so it can be
   viewed from the product page: status ('available' | 'pending' |
   'not-applicable'), lab, reportId, batch, method, testDate, reportDate,
   purity, content, file, verifyUrl, note.
   Every value is copied from the published report — never estimated.
   `note` on an 'available' block states the report's SCOPE where it does not
   line up with the listing (a different vial size or composition), so the
   difference is on the page rather than left for the buyer to spot.
   Descriptions describe each material's research context only.
   They make no human-use, treatment, or physiological-benefit claims.
   ============================================================ */

/* `icon` names a line-art glyph drawn by categoryIcon() in main.js. Emoji were
   used here originally; they render as a different picture on every OS and read
   as consumer-app decoration, which is the wrong register for a supplier of
   documented laboratory materials.

   The catalog is grouped by what each material IS — its molecular class — and
   never by what it is thought to do. Grouping by biological system (the old
   'Growth-Factor Peptides' / 'Metabolic' / 'Tissue & Matrix' headings) reads as
   a claim about an effect even when no sentence on the page makes one, which is
   exactly what a research-supplier listing must not do. Keep any new category
   compositional: chain length, molecule type, blend vs. single component. */
const CATEGORIES = [
  { key: 'growth',   name: 'Proteins & Long-Chain Peptides', icon: 'helix',    blurb: 'Recombinant proteins and long-chain peptides, supplied lyophilized' },
  { key: 'metabolic',name: 'Peptides & Cofactors',           icon: 'bolt',     blurb: 'Synthetic peptides and coenzymes, supplied lyophilized' },
  { key: 'repair',   name: 'Short-Chain Peptides',           icon: 'lattice',  blurb: 'Tripeptides, oligopeptides and metal-complexed peptides' },
  { key: 'blends',   name: 'Multi-Peptide Blends',           icon: 'layers',   blurb: 'Co-lyophilized multi-component research formulations' }
];

const PRODUCTS = [
  {
    id: 1,
    name: 'Retatrutide',
    category: 'metabolic',
    categoryName: 'Peptides & Cofactors',
    price: 109.99,
    originalPrice: 134.99,
    purity: '99.2%',
    quantity: '10mg',
    lot: 'ENL-24001',
    description: 'Triple–receptor-agonist research peptide (GLP-1 / GIP / glucagon receptor) used as a reference compound in in-vitro metabolic-pathway research. Supplied lyophilized for laboratory use.',
    specs: {
      'Molecular Formula': 'C221H342N46O68',
      'Molecular Weight': '4731.3 g/mol',
      'Purity (HPLC)': '99.2%',
      'Form': 'Lyophilized powder',
      'Storage': '-20°C, desiccated'
    },
    coa: {
      status: 'available',
      lab: 'Janoshik Analytical',
      reportId: '#137638',
      batch: 'CS-re10-0322',
      testDate: '2026-04-07',
      reportDate: '2026-04-10',
      purity: '99.786%',
      content: 'Retatrutide 11.86 mg',
      file: 'assets/coa/137638.pdf',
      verifyUrl: 'https://janoshik.com'
    },
    inStock: true,
    badge: 'Bestseller',
    featured: true
  },
  {
    id: 3,
    name: 'GHK-Cu (Copper Peptide)',
    category: 'repair',
    categoryName: 'Short-Chain Peptides',
    price: 85.00,
    originalPrice: null,
    purity: '99.0%',
    quantity: '50mg',
    lot: 'ENL-24003',
    description: 'Copper tripeptide-1 (glycyl-L-histidyl-L-lysine:copper), a well-characterized copper-binding peptide used as a reference compound in in-vitro research. Supplied lyophilized for laboratory use.',
    specs: {
      'Molecular Formula': 'C14H24N6O4·Cu',
      'Molecular Weight': '403.9 g/mol',
      'Purity (HPLC)': '99.0%',
      'Form': 'Lyophilized powder',
      'Storage': '-20°C, desiccated'
    },
    coa: {
      status: 'available',
      lab: 'Janoshik Analytical',
      reportId: '#122571',
      batch: 'CS-gu50-0309',
      testDate: '2026-03-17',
      reportDate: '2026-03-18',
      purity: '99.780%',
      content: 'GHK-Cu 60.04 mg',
      file: 'assets/coa/122571.pdf',
      verifyUrl: 'https://janoshik.com'
    },
    inStock: true,
    badge: null,
    featured: true
  },
  {
    id: 4,
    name: 'Tesamorelin / Ipamorelin Blend',
    category: 'growth',
    categoryName: 'Proteins & Long-Chain Peptides',
    price: 125.00,
    originalPrice: null,
    purity: 'ID + content',
    quantity: '10mg / 3mg',
    lot: 'ENL-24004',
    description: 'A co-lyophilized blend of a GHRH-analog peptide (Tesamorelin) and a growth-hormone-secretagogue peptide (Ipamorelin), supplied for in-vitro growth-factor-pathway research.',
    specs: {
      'Components': 'Tesamorelin 10mg + Ipamorelin 3mg',
      'Analysis': 'Identity + content per component (blend)',
      'Form': 'Co-lyophilized powder',
      'Storage': '-20°C, desiccated'
    },
    coa: {
      status: 'available',
      lab: 'Ozcanium Analytics',
      reportId: 'OZ-HPLCMS-0ASZ',
      batch: '22/07/2026',
      method: 'UPLC-MS/MS',
      testDate: '2026-07-29',
      reportDate: '2026-07-31',
      purity: '99.53%',
      content: 'Ipamorelin 5.32 mg · CJC-1295 5.13 mg',
      /* Scope note, shown on the panel: the report on file was issued for an
         Ipamorelin + CJC-1295 5mg/5mg vial, which is not the composition this
         listing states. It is published as-is at the owner's direction. */
      note: 'The report on file for this listing was issued for an Ipamorelin + CJC-1295 5mg / 5mg vial and reports those two components. It does not analyze Tesamorelin. Read the document below before ordering, and contact us if you need a report matching the stated 10mg / 3mg Tesamorelin / Ipamorelin composition.',
      file: 'assets/coa/OZ-HPLCMS-0ASZ.jpg',
      verifyUrl: 'https://ozcaniumanalytics.com.au'
    },
    inStock: true,
    badge: 'New',
    featured: true
  },
  {
    id: 5,
    name: 'MOTS-C',
    category: 'metabolic',
    categoryName: 'Peptides & Cofactors',
    price: 100.00,
    originalPrice: null,
    purity: '99.1%',
    quantity: '10mg',
    lot: 'ENL-24005',
    description: 'A mitochondrial-derived peptide used as a reference compound in in-vitro metabolic-pathway and cellular-signaling research. Supplied lyophilized for laboratory use.',
    specs: {
      'Molecular Formula': 'C101H152N28O22S2',
      'Molecular Weight': '2174.6 g/mol',
      'Purity (HPLC)': '99.1%',
      'Form': 'Lyophilized powder',
      'Storage': '-20°C, desiccated'
    },
    coa: {
      status: 'available',
      lab: 'Janoshik Analytical',
      reportId: '#147077',
      batch: 'CS-mc10-0408',
      testDate: '2026-04-20',
      reportDate: '2026-04-23',
      purity: '99.025%',
      content: 'MOTS-C 11.82 mg',
      file: 'assets/coa/147077.pdf',
      verifyUrl: 'https://janoshik.com'
    },
    inStock: true,
    badge: null,
    featured: false
  },
  {
    id: 6,
    name: 'BPC-157 / TB-500 Blend',
    category: 'repair',
    categoryName: 'Short-Chain Peptides',
    price: 130.00,
    originalPrice: null,
    purity: 'ID + content',
    quantity: '20mg',
    lot: 'ENL-24006',
    description: 'A co-lyophilized blend of two widely studied research peptides — Body Protection Compound-157 and a Thymosin Beta-4 fragment (TB-500) — supplied for in-vitro research. See the COA Library for lot identity and measured content.',
    specs: {
      'Components': 'BPC-157 10mg + TB-500 10mg',
      'Analysis': 'Identity + content per component (blend)',
      'Form': 'Co-lyophilized powder',
      'Storage': '-20°C, desiccated',
      'Documentation': 'Available — Janoshik #151337'
    },
    coa: {
      status: 'available',
      lab: 'Janoshik Analytical',
      reportId: '#151337',
      batch: 'CS-bb1010-0408',
      testDate: '2026-04-20',
      reportDate: '2026-04-23',
      purity: 'Not applicable (blend)',
      content: 'BPC-157 12.60 mg · TB-500 11.90 mg',
      file: 'assets/coa/151337.pdf',
      verifyUrl: 'https://janoshik.com'
    },
    inStock: true,
    badge: 'Popular',
    featured: true
  },
  {
    id: 7,
    name: 'KLOW Blend',
    category: 'blends',
    categoryName: 'Multi-Peptide Blends',
    price: 150.00,
    originalPrice: 159.99,
    purity: 'ID + content',
    quantity: '80mg',
    lot: 'ENL-24007',
    description: 'A multi-peptide research blend (GHK-Cu, KPV, TB-500, BPC-157), co-lyophilized and supplied for in-vitro research. See the COA Library for per-component identity and measured content.',
    specs: {
      'Components': 'GHK-Cu · KPV · TB-500 · BPC-157',
      'Total Mass': '80mg',
      'Analysis': 'Identity + content per component (blend)',
      'Form': 'Co-lyophilized powder',
      'Storage': '-20°C, desiccated',
      'Documentation': 'Available — Janoshik #122606'
    },
    coa: {
      status: 'available',
      lab: 'Janoshik Analytical',
      reportId: '#122606',
      batch: 'CS-ko80-0309',
      testDate: '2026-03-17',
      reportDate: '2026-03-18',
      purity: 'Not applicable (blend)',
      content: 'GHK-Cu 60.90 mg · BPC-157 11.50 mg · TB-500 11.65 mg · KPV 12.22 mg',
      file: 'assets/coa/122606.pdf',
      verifyUrl: 'https://janoshik.com'
    },
    inStock: true,
    badge: 'Premium',
    featured: true
  },
  {
    id: 8,
    name: 'NAD+',
    category: 'metabolic',
    categoryName: 'Peptides & Cofactors',
    price: 80.00,
    originalPrice: null,
    purity: '99.0%',
    quantity: '500mg',
    lot: 'ENL-24008',
    description: 'Nicotinamide adenine dinucleotide — a redox coenzyme used as a reference compound in in-vitro studies of cellular metabolism and signaling. Supplied lyophilized for laboratory use.',
    specs: {
      'Molecular Formula': 'C21H27N7O14P2',
      'Molecular Weight': '663.4 g/mol',
      'Purity (HPLC)': '99.0%',
      'Form': 'Lyophilized powder',
      'Storage': '-20°C, desiccated'
    },
    coa: {
      status: 'available',
      lab: 'Janoshik Analytical',
      reportId: '#136634',
      batch: 'CS-na500-0403',
      testDate: '2026-04-10',
      reportDate: '2026-04-14',
      /* The report ordered identity + amount only — no purity figure was
         measured, so none is claimed here. */
      purity: 'Not reported (identity + amount analysis)',
      content: 'NAD+ 529.47 mg',
      file: 'assets/coa/136634.jpg',
      verifyUrl: 'https://janoshik.com'
    },
    inStock: true,
    badge: 'New',
    featured: false
  },
  {
    id: 9,
    name: 'HGH 36 IU',
    category: 'growth',
    categoryName: 'Proteins & Long-Chain Peptides',
    price: 189.99,
    originalPrice: null,
    purity: 'ID + content',
    quantity: '36 IU',
    lot: 'ENL-24009',
    description: 'Recombinant 191-amino-acid human growth hormone (somatropin), supplied lyophilized at 36 IU per vial as a reference protein for in-vitro growth-factor-pathway research.',
    specs: {
      'Sequence': '191 amino acids (recombinant somatropin)',
      'Molecular Weight': '22,124 Da',
      'Potency': '36 IU per vial (≈12mg)',
      'Form': 'Lyophilized powder',
      'Storage': '-20°C, desiccated'
    },
    coa: {
      status: 'available',
      lab: 'Janoshik Analytical',
      reportId: '#87374',
      batch: 'CS-h101026',
      testDate: '2025-11-06',
      reportDate: '2025-11-10',
      purity: '97.090%',
      content: 'rHGH 3.86 mg / 11.58 IU per vial · dimer and related proteins 0.225%',
      /* Scope note, shown on the panel: the report analyzed a 10 IU vial of
         this lot, not the 36 IU quantity this listing states. Published as-is
         at the owner's direction. */
      note: 'The report on file analyzed a 10 IU vial of this lot and measured 3.86 mg / 11.58 IU in that vial. This listing states 36 IU, so the report covers the lot\'s identity and purity but not the full listed quantity. Read the document below before ordering.',
      file: 'assets/coa/87374.jpg',
      verifyUrl: 'https://janoshik.com'
    },
    inStock: true,
    badge: 'New',
    featured: true
  }
];

/* Helper lookups */
function getProductById(id) {
  return PRODUCTS.find(p => p.id === Number(id)) || null;
}
function getProductsByCategory(key) {
  if (!key || key === 'all') return PRODUCTS;
  return PRODUCTS.filter(p => p.category === key);
}
function getFeaturedProducts() {
  return PRODUCTS.filter(p => p.featured);
}
function getCategoryCount(key) {
  return PRODUCTS.filter(p => p.category === key).length;
}

/* Expose for non-module scripts */
if (typeof window !== 'undefined') {
  window.PRODUCTS = PRODUCTS;
  window.CATEGORIES = CATEGORIES;
}

/* Expose for Node (backend reuses the same authoritative pricing) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CATEGORIES, PRODUCTS,
    getProductById, getProductsByCategory, getFeaturedProducts, getCategoryCount
  };
}
