#!/usr/bin/env node
/* ============================================================
   EVER NOVA LIFE — write the catalogue and delivery terms into
   the chat agent's knowledge base

   Builds two documents from the LIVE server and uploads them:

     Catalogue      every published product — name, what it is,
                    purity, size, lot, specs, price, stock
     Delivery       every enabled shipping method, its cost, its
                    ETA, and the free-shipping threshold

   Re-run it after any price, stock or rate change and it replaces
   both. That is the whole maintenance story:

     node tools/agent-catalog.js            build and upload
     node tools/agent-catalog.js --preview  print, upload nothing

   ---------------------------------------------------------------
   A NOTE ON THE PRICES IN HERE, because it will look wrong later.

   The agent's system prompt tells it to call `lookup_product` for
   every price and stock question, and never to quote either from
   memory or from a document. That rule stays. So the numbers below
   are BACKGROUND — they let the agent talk about the range, know
   what exists, and answer "what do you sell for metabolic research"
   without a tool call — while the number it actually quotes to a
   customer still comes from the live server on the day.

   That is deliberate. A price in a document is a photograph; the
   tool is a window. Both are useful, but only one of them can be
   wrong without anyone noticing.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_BASE = 'https://evernova-api.onrender.com';
const OUT_DIR = path.join(require('os').tmpdir(), 'enl-agent-docs');

const PREVIEW = process.argv.includes('--preview');

function die(m) { console.error('\n  ' + m + '\n'); process.exitCode = 1; throw new Error('halt'); }

async function get(endpoint) {
  const res = await fetch(API_BASE + endpoint);
  if (!res.ok) die(`GET ${endpoint} → ${res.status}. Is the server up?`);
  return res.json();
}

const money = n => '$' + Number(n).toFixed(2);

/* ---- catalogue ----
   Written as prose with headings rather than a table: the agent reads
   this as language, and a markdown table of twelve columns retrieves far
   worse than a short paragraph per product. */
function buildCatalog(products, stamp) {
  const live = products.filter(p => p.published !== false);
  const byCategory = {};
  live.forEach(p => {
    const key = p.categoryName || p.category || 'Other';
    (byCategory[key] = byCategory[key] || []).push(p);
  });

  let out = 'EVER NOVA LIFE — PRODUCT CATALOGUE\n';
  out += '==================================\n\n';
  out += `Every item below is supplied for in-vitro laboratory research use only.\n`;
  out += `This document was generated on ${stamp} and lists ${live.length} products.\n\n`;
  out += 'IMPORTANT: the prices and stock figures here are a snapshot taken on the\n';
  out += 'date above. Always call the lookup_product tool for the current price and\n';
  out += 'availability before telling a customer either one. Use this document to\n';
  out += 'know what exists and what it is, not to quote a number.\n\n';

  Object.keys(byCategory).sort().forEach(cat => {
    out += `\n${cat.toUpperCase()}\n${'-'.repeat(cat.length)}\n\n`;
    byCategory[cat].forEach(p => {
      out += `${p.name}\n`;
      if (p.description) out += `${p.description}\n`;
      const facts = [];
      if (p.quantity) facts.push(`Size: ${p.quantity}`);
      if (p.purity) facts.push(`Purity: ${p.purity}`);
      if (p.lot) facts.push(`Lot: ${p.lot}`);
      facts.push(`Price on ${stamp}: ${money(p.price)}`);
      if (p.originalPrice && p.originalPrice > p.price) {
        facts.push(`was ${money(p.originalPrice)}`);
      }
      const tracked = p.stockQty !== undefined && p.stockQty !== null && p.stockQty !== '';
      facts.push(p.inStock === false ? 'Not currently offered'
        : tracked ? `${p.stockQty} in stock on ${stamp}` : 'In stock');
      out += facts.join('. ') + '.\n';

      if (p.specs && Object.keys(p.specs).length) {
        out += 'Specifications: ' +
          Object.entries(p.specs).map(([k, v]) => `${k} ${v}`).join('; ') + '.\n';
      }
      if (p.coa && p.coa.status === 'available') {
        out += `A certificate of analysis is available${p.coa.lab ? `, tested by ${p.coa.lab}` : ''}. ` +
               `Ask for it by lot number.\n`;
      }
      out += '\n';
    });
  });

  out += '\nWHAT IS NOT IN THIS DOCUMENT\n';
  out += '----------------------------\n';
  out += 'Anything unpublished or retired. If a customer asks about a product not\n';
  out += 'listed here and lookup_product does not find it either, say we do not\n';
  out += 'currently offer it rather than guessing.\n';
  return out;
}

/* ---- delivery ---- */
function buildDelivery(shipping, stamp) {
  const methods = (shipping.methods || []).filter(m => m.enabled !== false);
  let out = 'EVER NOVA LIFE — DELIVERY AND SHIPPING\n';
  out += '=====================================\n\n';
  out += `Generated ${stamp}. Call lookup_product for prices; these shipping rates\n`;
  out += 'change rarely, but if a customer disputes one, say you will check rather\n';
  out += 'than insisting.\n\n';

  if (!methods.length) {
    out += 'No shipping methods are currently enabled.\n';
    return out;
  }

  out += 'SHIPPING METHODS\n----------------\n\n';
  methods.forEach(m => {
    out += `${m.name}: ${money(m.price)}`;
    if (m.eta) out += `, arriving in ${m.eta}`;
    out += '.';
    if (m.freeOver) out += ` Free on orders over ${money(m.freeOver)}.`;
    out += '\n';
  });

  const free = methods.filter(m => m.freeOver).map(m => m.freeOver);
  if (free.length) {
    out += `\nFree shipping applies once the order reaches ${money(Math.min(...free))}.\n`;
  }

  out += '\nWHERE WE SHIP\n-------------\n';
  out += 'United States only. We do not ship internationally.\n';

  out += '\nTRACKING AN ORDER\n-----------------\n';
  out += 'You cannot look up orders. Send the customer to the order-status page on\n';
  out += 'the site, where they enter their order reference and the email address\n';
  out += 'they used. If they cannot find the reference, escalate to a person.\n';
  return out;
}

async function main() {
  const stamp = new Date().toISOString().slice(0, 10);

  process.stdout.write('  Reading the live catalogue… ');
  const { products } = await get('/api/products');
  console.log(products.length + ' products');

  process.stdout.write('  Reading the shipping rates… ');
  const shipping = await get('/api/shipping');
  console.log((shipping.methods || []).length + ' method(s)');

  const catalog = buildCatalog(products, stamp);
  const delivery = buildDelivery(shipping, stamp);

  if (PREVIEW) {
    console.log('\n' + '='.repeat(70) + '\n');
    console.log(catalog);
    console.log('\n' + '='.repeat(70) + '\n');
    console.log(delivery);
    console.log('\n  --preview: nothing was uploaded.\n');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const catalogFile = path.join(OUT_DIR, 'catalog.txt');
  const deliveryFile = path.join(OUT_DIR, 'delivery.txt');
  fs.writeFileSync(catalogFile, catalog);
  fs.writeFileSync(deliveryFile, delivery);

  /* Replace rather than add — running this twice should leave one copy of
     each, not two documents disagreeing about the price. `remove` is
     allowed to fail on the first run, when there is nothing to remove. */
  const run = (args) => {
    try {
      const out = execFileSync(process.execPath,
        [path.join(__dirname, 'agent-knowledge.js')].concat(args),
        { cwd: ROOT, encoding: 'utf8' });
      return out;
    } catch (e) {
      return (e.stdout || '') + (e.stderr || '');
    }
  };

  console.log('');
  // Output swallowed on purpose: on the first run there is nothing to
  // remove, and "No attached document called Catalogue" reads like a
  // failure when it is the expected state.
  run(['remove', 'Catalogue']);
  run(['remove', 'Delivery and shipping']);
  process.stdout.write(run(['add-text', 'Catalogue', catalogFile]));
  process.stdout.write(run(['add-text', 'Delivery and shipping', deliveryFile]));

  console.log('  Both documents are in. Re-run this after any price, stock or');
  console.log('  rate change and it replaces them.\n');
}

main().catch(e => { if (e.message !== 'halt') console.error('\n  Failed.\n  ' + e.message + '\n'); process.exitCode = 1; });
