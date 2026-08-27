#!/usr/bin/env node
/* ============================================================
   EVER NOVA LIFE — build the customer-service agent

   Does the whole ElevenLabs side of docs/AI-CHAT.md in one run,
   so nobody has to click through the dashboard and hand-copy a
   system prompt:

     1. uploads the policy pages from §4 to the knowledge base
     2. creates the three webhook tools from §5
     3. creates a text-only agent carrying the §3 prompt,
        wired to all three

   The prompt and the page list are READ OUT OF docs/AI-CHAT.md,
   never duplicated here. That document is the reviewed one; a
   second copy in a script is a second thing to keep in step, and
   the copy that drifts is always the one nobody is reading.

   Usage:
     node tools/setup-elevenlabs-agent.js --api-base <url> [--site <url>] [--dry-run]
     node tools/setup-elevenlabs-agent.js --update <agent_id> --api-base <url>

     --api-base  where THIS project's server answers, e.g.
                 https://evernova-api.onrender.com — the agent's
                 tools are pointed here, so it must be the live
                 host and it must already be serving /api/agent/*
     --site      the public site the knowledge-base pages are read
                 from (default https://evernovalife.com)
     --update    push the §3 prompt and the §5 tools to an agent that
                 ALREADY EXISTS, in place. Use this for every run after
                 the first — see below.
     --dry-run   print what would be created and exit

   Run WITHOUT --update once, to build the agent. Run WITH it every
   time after that. The difference matters: the no-flag path creates a
   NEW agent and hands you a new id, and the site names exactly one
   agent id in js/config.js — so a second agent means editing that
   file, bumping its cache-buster and re-uploading every page, just to
   change a sentence in the prompt. --update patches the live agent
   instead: same id, knowledge base left attached, conversation history
   kept.

   Reads ELEVENLABS_API_KEY and ELEVENLABS_AGENT_SECRET from
   server/.env. Neither is ever printed.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* server/.env read directly rather than through dotenv: that package is
   installed under server/node_modules, and this script lives at the repo
   root, so requiring it would tie the script to being run from one
   directory. Only the two keys this script needs are taken, and neither
   overrides a value already exported in the environment. */
(function loadEnv() {
  let raw;
  try { raw = fs.readFileSync(path.join(ROOT, 'server', '.env'), 'utf8'); }
  catch (e) { return; }                                  // no file is fine; the checks below report it
  raw.split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    const key = m[1];
    if (process.env[key] !== undefined) return;
    process.env[key] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  });
}());

const API = 'https://api.elevenlabs.io';
const DOC = path.join(ROOT, 'docs', 'AI-CHAT.md');
const AGENT_NAME = 'Ever Nova Life — customer service';

/* ---- arguments ---- */
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry-run');
const SITE = String(arg('site', 'https://evernovalife.com')).replace(/\/+$/, '');
const API_BASE = String(arg('api-base', '')).replace(/\/+$/, '');
const UPDATE_ID = String(arg('update', '')).trim();

function die(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

/* ---- read the prompt and the page list out of the doc ----
   §3 is the only fenced block in that section, and §4's list is the
   bullet list of *.html names beneath its heading. Both are pulled by
   structure rather than by line number so an edit to the prose above
   them doesn't silently shift what gets uploaded. */
function readDoc() {
  let md;
  try { md = fs.readFileSync(DOC, 'utf8'); }
  catch (e) { die(`Could not read ${DOC}. Run this from the project root.`); }
  // The working copy is checked out with CRLF on Windows. Normalise once
  // here so every pattern below can be written against \n, and so the
  // prompt that reaches ElevenLabs has no stray carriage returns in it.
  md = md.replace(/\r\n/g, '\n');

  const promptSection = md.split(/^## 3\. /m)[1];
  if (!promptSection) die('docs/AI-CHAT.md has no "## 3." section — has it been restructured?');
  const fence = /```\n([\s\S]*?)```/.exec(promptSection);
  if (!fence) die('Could not find the fenced system prompt in §3 of docs/AI-CHAT.md.');
  const prompt = fence[1].trim();
  if (prompt.length < 500) die('The system prompt read from §3 looks too short — check docs/AI-CHAT.md.');

  const kbSection = (md.split(/^## 4\. /m)[1] || '').split(/^## 5\. /m)[0];
  const pages = [...kbSection.matchAll(/^- `([a-z0-9-]+\.html)`/gm)].map(m => m[1]);
  if (!pages.length) die('Could not find the knowledge-base page list in §4 of docs/AI-CHAT.md.');

  return { prompt, pages };
}

/* ---- HTTP ----
   Every failure prints the API's own response body. A setup script that
   swallows the reason is worse than no script: the whole point is that
   the person running it can act on what went wrong. */
/* A validation error echoes the offending request straight back, headers
   and all — which means our own shared secret arrives in the response body
   and lands on the terminal, in a screenshot, in the issue someone pastes
   it into. The header above promises these are never printed; this is what
   makes that true. */
function scrub(text) {
  let out = String(text);
  [
    ['ELEVENLABS_AGENT_SECRET', process.env.ELEVENLABS_AGENT_SECRET],
    ['ELEVENLABS_API_KEY', process.env.ELEVENLABS_API_KEY],
    ['ELEVENLABS_WEBHOOK_SECRET', process.env.ELEVENLABS_WEBHOOK_SECRET]
  ].forEach(([name, value]) => {
    if (value && value.length > 8) out = out.split(value).join('<' + name + ' redacted>');
  });
  return out;
}

async function call(method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* keep the raw text */ }
  if (!res.ok) {
    const detail = (data && (data.detail || data.message)) || text || '(no body)';
    throw Object.assign(
      new Error(scrub(`${method} ${endpoint} → ${res.status}\n  ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`)),
      { status: res.status }
    );
  }
  return data;
}

/* ---- the three tools from §5 ----
   Kept here rather than parsed out of the doc: unlike the prompt, these
   are machine shapes, and a table in Markdown is a poor source of truth
   for a JSON schema. The doc describes them for a human; this is what is
   actually sent. If you change one, change both. */
function toolConfigs() {
  const headers = { 'x-agent-secret': process.env.ELEVENLABS_AGENT_SECRET };
  return [
    {
      type: 'webhook',
      name: 'lookup_product',
      description:
        'Look up a product in the live catalogue to get its current price and whether it is in stock. ' +
        'Always call this before stating any price or availability — never answer either from memory or ' +
        'from the knowledge base. Returns at most five matches.',
      response_timeout_secs: 10,
      api_schema: {
        url: `${API_BASE}/api/agent/product`,
        method: 'GET',
        request_headers: headers,
        query_params_schema: {
          properties: {
            q: {
              type: 'string',
              description: 'The product name or part of it, as the visitor said it. Leave empty to list the catalogue.'
            }
          },
          required: []
        }
      }
    },
    {
      type: 'webhook',
      name: 'escalate',
      description:
        'Hand the conversation to a person. Call this when you have refused something and they still need ' +
        'help, when the knowledge base does not cover their question, when they ask for a human, or when ' +
        'they sound frustrated. Ask for their email address BEFORE calling this. Read the returned ' +
        'reference number back to them.',
      response_timeout_secs: 15,
      api_schema: {
        url: `${API_BASE}/api/agent/escalate`,
        method: 'POST',
        request_headers: headers,
        request_body_schema: {
          type: 'object',
          properties: {
            email: {
              type: 'string',
              description: "The visitor's email address, which you must ask for before calling this."
            },
            name: { type: 'string', description: 'Their name, if they gave one. Optional.' },
            subject: { type: 'string', description: 'A short line describing what they need.' },
            body: { type: 'string', description: 'A plain summary of the question, in your own words.' },
            transcript: {
              type: 'array',
              description: 'The conversation so far, oldest first.',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', description: "Either 'user' or 'agent'." },
                  text: { type: 'string', description: 'What was said.' },
                  at: { type: 'string', description: 'ISO timestamp, if known.' }
                }
              }
            }
          },
          required: ['email', 'subject', 'body']
        }
      }
    },
    {
      type: 'webhook',
      name: 'get_my_account',
      description:
        'Read the account of the person you are talking to: their recent orders and delivery status, ' +
        'their points balance, their auto-ship plans and their cart. Call this for ANY question about ' +
        'their own order, delivery, points, plans or cart — but only when {{signed_in}} is "true". ' +
        'Never ask a signed-in person for an order reference; this tool already knows who they are. ' +
        'It is read-only: it cannot cancel, pause, redeem or change anything.',
      response_timeout_secs: 10,
      api_schema: {
        url: `${API_BASE}/api/agent/account`,
        method: 'POST',
        /* Two headers, two questions. The shared secret says the call came
           from our agent; the account token says which visitor it is for.
           The token is templated in by ElevenLabs, so the model never sees
           it, cannot retype it wrongly, and cannot put it in the transcript.

           There are deliberately NO parameters for the model to fill in:
           nothing it can say points this tool at a different account. */
        request_headers: {
          ...headers,
          'x-account-token': '{{account_token}}'
        },
        /* Empty, but required: ElevenLabs rejects a POST tool without a
           body schema (422, "POST method requires request_body_schema").
           No properties is the point — there is nothing here for the model
           to fill in, so nothing it can say points this tool at somebody
           else's account. The server ignores the body entirely and reads
           the account from the token. */
        request_body_schema: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    }
  ];
}

/* ---- how the bubble looks ----
   Straight off the printed vial label, which is where the whole site's
   palette comes from: near-black substrate, gold hairline, violet for the
   thing you press. Left at the vendor's default the widget arrives white
   and blue, which on this site reads as somebody else's software bolted
   onto the corner of the page.

   `variant: 'expandable'` keeps it a small bubble until it is opened.
   The copy is deliberately plain — "Questions?" rather than anything
   implying a person is waiting to type back. */
const WIDGET = {
  variant: 'expandable',
  placement: 'bottom-right',
  bg_color: '#120a22',            // --dark-surface, one step up from the page
  text_color: '#ececf5',          // --dark-text
  btn_color: '#7c3aed',           // the violet actions carry site-wide
  btn_text_color: '#ffffff',
  border_color: 'rgba(214, 182, 86, 0.34)',   // --glass-border-strong, the gold hairline
  focus_color: '#a855f7',         // --accent-purple
  border_radius: 16,
  action_text: 'Questions?',
  start_call_text: 'Ask a question',
  end_call_text: 'End chat',
  expand_text: 'Open chat',
  avatar: { type: 'orb', color_1: '#7c3aed', color_2: '#d4af37' }
};

/* Apply the look to an agent that already exists, without touching its
   prompt, tools or knowledge base. Used by --restyle. */
async function restyle(agentId) {
  process.stdout.write('  Restyling ' + agentId + '… ');
  await call('PATCH', '/v1/convai/agents/' + encodeURIComponent(agentId), {
    platform_settings: { widget: WIDGET }
  });
  console.log('ok');
  console.log('');
  console.log('  The widget config lives on the agent, not in your site files —');
  console.log('  so this takes effect on reload. Nothing needs re-uploading.');
  console.log('');
}

/* Every tool in the workspace, keyed by name. Paginated because the list
   endpoint is: a workspace that has accumulated tools across several runs
   would otherwise be read one page deep and the older records missed. */
async function toolsByName() {
  const found = new Map();
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const res = await call('GET', '/v1/convai/tools?page_size=100' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    ((res && res.tools) || []).forEach(t => {
      const name = t && t.tool_config && t.tool_config.name;
      const id = t && (t.id || t.tool_id);
      if (name && id && !found.has(name)) found.set(name, id);
    });
    if (!res || !res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return found;
}

/* ---- --update: push the prompt and tools to the LIVE agent ----
   The create path further down makes a new agent every run, which is right
   exactly once. After that it is wrong in an expensive way: js/config.js
   names one agent id, so adopting a new one means editing that file,
   bumping its cache-buster and re-uploading all 27 pages — to change a
   sentence. This rewrites the prompt and the tool wiring on the agent the
   site already talks to, and touches nothing else. */
async function updateExisting(agentId, prompt) {
  /* Read before writing. PATCH is a partial update at the top level, but
     `prompt` is a nested OBJECT — sending a fresh one carrying only two
     keys risks taking knowledge_base, llm and temperature down with it.
     One GET removes the guesswork. */
  process.stdout.write('  Reading the agent… ');
  const current = await call('GET', '/v1/convai/agents/' + encodeURIComponent(agentId));
  const agentCfg = ((current || {}).conversation_config || {}).agent || {};
  const currentPrompt = agentCfg.prompt || {};
  const attached = (currentPrompt.knowledge_base || []).length;
  console.log('ok');
  console.log('    ' + attached + ' knowledge document' + (attached === 1 ? '' : 's') +
    ' attached — left exactly as they are');

  /* Matched BY NAME against what the workspace already holds, so a second
     run re-points the same three records instead of creating a fresh set
     each time and orphaning the previous one on no agent at all. */
  const existing = await toolsByName();
  const toolIds = [];
  for (const cfg of toolConfigs()) {
    const id = existing.get(cfg.name);
    if (id) {
      process.stdout.write('  Updating tool ' + cfg.name + '… ');
      await call('PATCH', '/v1/convai/tools/' + encodeURIComponent(id), { tool_config: cfg });
      toolIds.push(id);
    } else {
      process.stdout.write('  Creating tool ' + cfg.name + '… ');
      const made = await call('POST', '/v1/convai/tools', { tool_config: cfg });
      const newId = made && (made.id || made.tool_id);
      if (!newId) die(`No tool id came back for ${cfg.name}. Response: ${JSON.stringify(made)}`);
      toolIds.push(newId);
    }
    console.log('ok');
  }

  process.stdout.write('  Patching the agent… ');
  await call('PATCH', '/v1/convai/agents/' + encodeURIComponent(agentId), {
    conversation_config: {
      agent: {
        prompt: { ...currentPrompt, prompt, tool_ids: toolIds },
        /* Re-sent on every update rather than assumed: an agent created
           before these existed has none, and a conversation that starts
           without dynamic variables would otherwise leave {{first_name}}
           as literal text in the prompt. */
        dynamic_variables: {
          dynamic_variable_placeholders: {
            signed_in: 'false',
            first_name: '',
            account_token: ''
          }
        }
      }
    }
  });
  console.log('ok');

  console.log('');
  console.log('  Done. Agent ' + agentId + ' now carries the §3 prompt and all three tools.');
  console.log('  Nothing needs re-uploading — js/config.js already names this agent.');
  console.log('');
  console.log('  Check it: open the site signed in and ask "where is my order".');
  console.log('  Then sign out, reload, and ask again — it should point at the');
  console.log('  order-status page instead.');
  console.log('');
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    die('ELEVENLABS_API_KEY is not set.\n  Put it in server/.env — that file is git-ignored:\n\n    ELEVENLABS_API_KEY=sk_...');
  }

  /* --restyle <agent_id>: repaint an existing agent and stop. Wanted
     because the look is the one thing you iterate on after everything
     else is working, and rebuilding the agent to change a colour would
     mean re-uploading the knowledge base for nothing. */
  const restyleId = arg('restyle', '');
  if (restyleId) {
    console.log('');
    await restyle(restyleId);
    return;
  }
  if (!process.env.ELEVENLABS_AGENT_SECRET) {
    die('ELEVENLABS_AGENT_SECRET is not set.\n  Generate one and put it in server/.env AND in Render\'s Environment tab:\n\n    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (!API_BASE) {
    die('Missing --api-base.\n  This is where your server answers, and the agent\'s tools are pointed at it:\n\n    node tools/setup-elevenlabs-agent.js --api-base https://evernova-api.onrender.com');
  }
  if (!/^https:\/\//.test(API_BASE)) die('--api-base must be an https:// URL.');

  const { prompt, pages } = readDoc();

  console.log('');
  console.log('  Agent      ' + (UPDATE_ID ? UPDATE_ID + '  (patched in place)'
                                           : AGENT_NAME + '  (created new)'));
  console.log('  Tools →    ' + API_BASE + '/api/agent/{product,escalate,account}');
  if (UPDATE_ID) {
    console.log('  Knowledge  untouched — whatever is attached to this agent stays');
  } else {
    console.log('  Knowledge  ' + pages.length + ' pages from ' + SITE);
    pages.forEach(p => console.log('               ' + SITE + '/' + p));
  }
  console.log('  Prompt     §3 of docs/AI-CHAT.md, ' + prompt.split('\n').length + ' lines');
  console.log('');

  if (DRY) {
    console.log('  --dry-run: nothing was ' + (UPDATE_ID ? 'changed' : 'created') + '.\n');
    return;
  }

  /* Fail on a bad key before creating anything half-way. */
  process.stdout.write('  Checking the API key… ');
  await call('GET', '/v1/convai/agents?page_size=1');
  console.log('ok');

  if (UPDATE_ID) {
    await updateExisting(UPDATE_ID, prompt);
    return;
  }

  /* ---- 1. knowledge base ----
     from_url, so ElevenLabs fetches the live page itself. That means the
     site must already be published with the copy you want it to learn. */
  const knowledge = [];
  for (const page of pages) {
    const url = `${SITE}/${page}`;
    process.stdout.write(`  Uploading ${page}… `);
    const doc = await call('POST', '/v1/convai/knowledge-base/url', { url, name: page });
    const id = doc && (doc.id || doc.document_id);
    if (!id) die(`No document id came back for ${page}. Response: ${JSON.stringify(doc)}`);
    knowledge.push({ type: 'url', name: page, id, usage_mode: 'auto' });
    console.log('ok');
  }

  /* ---- 2. tools ---- */
  const toolIds = [];
  for (const cfg of toolConfigs()) {
    process.stdout.write(`  Creating tool ${cfg.name}… `);
    const tool = await call('POST', '/v1/convai/tools', { tool_config: cfg });
    const id = tool && (tool.id || tool.tool_id);
    if (!id) die(`No tool id came back for ${cfg.name}. Response: ${JSON.stringify(tool)}`);
    toolIds.push(id);
    console.log('ok');
  }

  /* ---- 3. the agent ----
     text_only is the whole point: this is a chat bubble, not a phone
     line, and audio would be billed per minute. */
  process.stdout.write('  Creating the agent… ');
  const agent = await call('POST', '/v1/convai/agents/create', {
    name: AGENT_NAME,
    conversation_config: {
      agent: {
        prompt: {
          prompt,
          llm: 'gpt-4o-mini',
          temperature: 0,
          tool_ids: toolIds,
          knowledge_base: knowledge
        },
        first_message: 'Hello — ask me anything about our catalogue, documentation, shipping or returns.',
        language: 'en',
        /* Safe defaults for a conversation that starts without dynamic
           variables set at all — the dashboard's own test chat, or any
           client that skips them. Mirrors the signed-out object js/chat.js
           always sends ({ signed_in: 'false', first_name: '', account_token: ''
           }), so a conversation missing the attribute behaves exactly like
           a real signed-out visitor instead of leaving {{first_name}} and
           {{account_token}} as literal text in the prompt/tool header. */
        dynamic_variables: {
          dynamic_variable_placeholders: {
            signed_in: 'false',
            first_name: '',
            account_token: ''
          }
        }
      },
      conversation: { text_only: true }
    },
    platform_settings: { widget: WIDGET }
  });
  const agentId = agent && (agent.agent_id || agent.id);
  if (!agentId) die(`No agent id came back. Response: ${JSON.stringify(agent)}`);
  console.log('ok');

  console.log('');
  console.log('  Done. Agent id:  ' + agentId);
  console.log('');
  console.log('  Next:');
  console.log('    1. Put it in js/config.js:');
  console.log(`         window.ENL_CHAT = { agentId: '${agentId}', version: '' };`);
  console.log('    2. Set ELEVENLABS_AGENT_SECRET in Render (same value as server/.env),');
  console.log('       and confirm ' + API_BASE + '/api/agent/product returns 401 without a header.');
  console.log('    3. Set the post-call webhook to ' + API_BASE + '/api/agent/transcript');
  console.log('       with ELEVENLABS_WEBHOOK_SECRET — see §6 of docs/AI-CHAT.md.');
  console.log('    4. Upload js/ and css/ to the host BEFORE the HTML (Cloudflare caches 4h).');
  console.log('');
}

main().catch(e => {
  console.error('\n  Failed.\n  ' + e.message);
  console.error('\n  Nothing further was created. Fix the above and run it again.');
  if (UPDATE_ID) {
    console.error('  --update is re-runnable: tools are matched by name, so a second');
    console.error('  attempt re-points the same records rather than duplicating them.\n');
  } else {
    console.error('  Any knowledge-base documents already uploaded are still there —');
    console.error('  delete them in the dashboard if you want a clean second run.\n');
  }
  process.exit(1);
});
