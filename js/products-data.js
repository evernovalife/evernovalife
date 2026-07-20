/* ============================================================
   EVER NOVA LIFE — Product Catalog
   8 SKUs · For in-vitro research and laboratory use only
   Each product: id, name, category, categoryName, price,
   originalPrice, purity, quantity, description, specs{},
   inStock, badge, featured, lot
   Descriptions describe each material's research context only.
   They make no human-use, treatment, or physiological-benefit claims.
   ============================================================ */

const CATEGORIES = [
  { key: 'growth',   name: 'Growth-Factor Peptides', emoji: '🧬', blurb: 'Growth-factor and secretagogue research peptides' },
  { key: 'metabolic',name: 'Metabolic',      emoji: '⚡', blurb: 'Metabolic-pathway research peptides' },
  { key: 'repair',   name: 'Tissue & Matrix', emoji: '🩹', blurb: 'Peptides used in tissue and extracellular-matrix research' },
  { key: 'blends',   name: 'Multi-Peptide Blends', emoji: '✨', blurb: 'Multi-peptide research formulations' },
  { key: 'supplies', name: 'Lab Supplies',   emoji: '🧪', blurb: 'Reconstitution & laboratory essentials' }
];

const PRODUCTS = [
  {
    id: 1,
    name: 'Retatrutide',
    category: 'metabolic',
    categoryName: 'Metabolic',
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
      'Storage': '-20°C, desiccated',
      'Reconstitution': 'Bacteriostatic water'
    },
    inStock: true,
    badge: 'Bestseller',
    featured: true
  },
  {
    id: 2,
    name: 'Bacteriostatic Water',
    category: 'supplies',
    categoryName: 'Lab Supplies',
    price: 8.99,
    originalPrice: 11.99,
    purity: '0.9% Benzyl Alcohol',
    quantity: '30mL',
    lot: 'ENL-24002',
    description: 'Sterile water with 0.9% benzyl alcohol for reconstitution of lyophilized research peptides in the laboratory. Multi-dose laboratory reagent.',
    specs: {
      'Composition': 'Sterile water + 0.9% benzyl alcohol',
      'Volume': '30mL multi-dose vial',
      'Grade': 'Laboratory reagent',
      'Form': 'Liquid',
      'Storage': 'Room temperature',
      'Use': 'Peptide reconstitution'
    },
    inStock: true,
    badge: 'Essential',
    featured: true
  },
  {
    id: 3,
    name: 'GHK-Cu (Copper Peptide)',
    category: 'repair',
    categoryName: 'Tissue Repair',
    price: 39.99,
    originalPrice: 49.99,
    purity: '99.0%',
    quantity: '50mg',
    lot: 'ENL-24003',
    description: 'Copper tripeptide-1 (glycyl-L-histidyl-L-lysine:copper), a well-characterized copper-binding peptide used as a reference compound in in-vitro research. Supplied lyophilized for laboratory use.',
    specs: {
      'Molecular Formula': 'C14H24N6O4·Cu',
      'Molecular Weight': '403.9 g/mol',
      'Purity (HPLC)': '99.0%',
      'Form': 'Lyophilized powder',
      'Storage': '-20°C, desiccated',
      'Reconstitution': 'Bacteriostatic water'
    },
    inStock: true,
    badge: null,
    featured: true
  },
  {
    id: 4,
    name: 'Tesamorelin / Ipamorelin Blend',
    category: 'growth',
    categoryName: 'Growth Factors',
    price: 79.99,
    originalPrice: 94.99,
    purity: 'ID + content',
    quantity: '10mg / 3mg',
    lot: 'ENL-24004',
    description: 'A co-lyophilized blend of a GHRH-analog peptide (Tesamorelin) and a growth-hormone-secretagogue peptide (Ipamorelin), supplied for in-vitro growth-factor-pathway research.',
    specs: {
      'Components': 'Tesamorelin 10mg + Ipamorelin 3mg',
      'Analysis': 'Identity + content per component (blend)',
      'Form': 'Co-lyophilized powder',
      'Storage': '-20°C, desiccated',
      'Reconstitution': 'Bacteriostatic water',
      'Documentation': 'Pending — see Quality & Documentation'
    },
    inStock: true,
    badge: 'New',
    featured: true
  },
  {
    id: 5,
    name: 'MOTS-C',
    category: 'metabolic',
    categoryName: 'Metabolic',
    price: 64.99,
    originalPrice: 79.99,
    purity: '99.1%',
    quantity: '10mg',
    lot: 'ENL-24005',
    description: 'A mitochondrial-derived peptide used as a reference compound in in-vitro metabolic-pathway and cellular-signaling research. Supplied lyophilized for laboratory use.',
    specs: {
      'Molecular Formula': 'C101H152N28O22S2',
      'Molecular Weight': '2174.6 g/mol',
      'Purity (HPLC)': '99.1%',
      'Form': 'Lyophilized powder',
      'Storage': '-20°C, desiccated',
      'Reconstitution': 'Bacteriostatic water'
    },
    inStock: true,
    badge: null,
    featured: false
  },
  {
    id: 6,
    name: 'BPC-157 / TB-500 Blend',
    category: 'repair',
    categoryName: 'Tissue Repair',
    price: 89.99,
    originalPrice: 109.99,
    purity: 'ID + content',
    quantity: '20mg',
    lot: 'ENL-24006',
    description: 'A co-lyophilized blend of two widely studied research peptides — Body Protection Compound-157 and a Thymosin Beta-4 fragment (TB-500) — supplied for in-vitro research. See the COA Library for lot identity and measured content.',
    specs: {
      'Components': 'BPC-157 10mg + TB-500 10mg',
      'Analysis': 'Identity + content per component (blend)',
      'Form': 'Co-lyophilized powder',
      'Storage': '-20°C, desiccated',
      'Reconstitution': 'Bacteriostatic water',
      'Documentation': 'Available — Janoshik #151337'
    },
    inStock: true,
    badge: 'Popular',
    featured: true
  },
  {
    id: 7,
    name: 'KLOW Blend',
    category: 'blends',
    categoryName: 'Premium Blends',
    price: 129.99,
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
      'Reconstitution': 'Bacteriostatic water',
      'Documentation': 'Available — Janoshik #122606'
    },
    inStock: true,
    badge: 'Premium',
    featured: true
  },
  {
    id: 8,
    name: 'NAD+',
    category: 'metabolic',
    categoryName: 'Metabolic',
    price: 100.00,
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
      'Storage': '-20°C, desiccated',
      'Reconstitution': 'Bacteriostatic water'
    },
    inStock: true,
    badge: 'New',
    featured: false
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
