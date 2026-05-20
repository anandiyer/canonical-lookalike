/* Lookalike Finder — frontend.
   Streams the Worker's pipeline over a fetch/ReadableStream SSE channel and
   renders the stepper, source profile, and match cards as events arrive. */

// Point this at your deployed Cloudflare Worker. Resolution order:
//   1. ?api=… query param (explicit override)
//   2. localhost → the local `wrangler dev` Worker (so no param needed in dev)
//   3. the deployed production Worker
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const ENDPOINT =
  new URLSearchParams(location.search).get("api") ||
  (LOCAL_HOSTS.includes(location.hostname)
    ? "http://localhost:8787"
    : "https://labs-api.canonical.cc");

const STEPS = [
  ["ingest", "Reconstructing profile"],
  ["traits", "Extracting traits"],
  ["queries", "Generating queries"],
  ["retrieve", "Searching the web"],
  ["score", "Scoring candidates"],
];

const ICONS = {
  linkedin:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V24h-4V8zm7.5 0h3.8v2.2h.05c.53-1 1.83-2.2 3.77-2.2 4.03 0 4.78 2.65 4.78 6.1V24h-4v-7.1c0-1.7-.03-3.9-2.38-3.9-2.38 0-2.75 1.86-2.75 3.78V24h-4V8z"/></svg>',
  x:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 1.5h3.3l-7.2 8.24L23.7 22.5h-6.6l-5.18-6.77L5.99 22.5H2.68l7.7-8.8L2.3 1.5h6.77l4.68 6.19L18.9 1.5zm-1.16 19h1.83L7.34 3.38H5.38L17.74 20.5z"/></svg>',
  link:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (x) => Math.round((x || 0) * 100);

let running = false;
let lastInput = "";

function buildStepper() {
  const wrap = $("stepper");
  wrap.innerHTML = "";
  STEPS.forEach(([id, label], i) => {
    const s = el("div", "step", `<span class="dot">${i + 1}</span><span>${label}</span>`);
    s.id = "step-" + id;
    wrap.appendChild(s);
  });
}

// Active step → yellow (with number); earlier steps → grey with a ✓; later → faint.
function setStep(id, state) {
  if (!$("step-" + id)) return;
  let passed = false;
  STEPS.forEach(([sid], i) => {
    const n = $("step-" + sid);
    const dot = n.querySelector(".dot");
    if (sid === id) {
      passed = true;
      const done = state === "done";
      n.className = "step " + (done ? "done" : "active");
      dot.textContent = done ? "✓" : String(i + 1);
    } else if (!passed) {
      n.className = "step done";
      dot.textContent = "✓";
    } else {
      n.className = "step";
      dot.textContent = String(i + 1);
    }
  });
}

// LinkedIn / X / source link buttons for any profile object.
function linkBtn(href, kind, label) {
  return `<a class="link-btn" href="${esc(href)}" target="_blank" rel="noopener">${ICONS[kind]}<span>${label}</span></a>`;
}
function renderLinks(container, obj) {
  const parts = [];
  if (obj.linkedin) parts.push(linkBtn(obj.linkedin, "linkedin", "LinkedIn"));
  if (obj.x) parts.push(linkBtn(obj.x, "x", "X"));
  if (!obj.linkedin && !obj.x && obj.url) parts.push(linkBtn(obj.url, "link", "Source"));
  container.innerHTML = parts.join("");
  container.style.display = parts.length ? "" : "none";
}

// Animated circular score gauge.
function scoreRing(score) {
  const p = pct(score);
  const r = 24;
  const c = 2 * Math.PI * r;
  const off = c * (1 - p / 100);
  const wrap = el(
    "div",
    "score",
    `<svg viewBox="0 0 58 58">
       <circle class="ring-bg" cx="29" cy="29" r="${r}" stroke-width="5"></circle>
       <circle class="ring-fg" cx="29" cy="29" r="${r}" stroke-width="5"
         stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${c.toFixed(1)}"></circle>
     </svg>
     <div class="pct">${p}%</div>`
  );
  const fg = wrap.querySelector(".ring-fg");
  requestAnimationFrame(() => (fg.style.strokeDashoffset = off.toFixed(1)));
  return wrap;
}

// Feedback affordance: a toggle that reveals a textarea → POSTs to /feedback.
function renderFeedback(container, target) {
  container.innerHTML =
    `<button class="fb-toggle" type="button">✎ Feedback on this result</button>
     <div class="fb-form is-hidden">
       <textarea placeholder="What was off — or right — about this? (e.g. wrong company, missed a key role, great match)"></textarea>
       <div class="fb-actions">
         <button class="fb-send" type="button">Send feedback</button>
         <button class="fb-cancel" type="button">Cancel</button>
       </div>
     </div>`;
  const toggle = container.querySelector(".fb-toggle");
  const form = container.querySelector(".fb-form");
  const ta = container.querySelector("textarea");
  const send = container.querySelector(".fb-send");
  const cancel = container.querySelector(".fb-cancel");

  toggle.addEventListener("click", () => {
    form.classList.toggle("is-hidden");
    if (!form.classList.contains("is-hidden")) ta.focus();
  });
  cancel.addEventListener("click", () => { form.classList.add("is-hidden"); ta.value = ""; });
  send.addEventListener("click", async () => {
    const comment = ta.value.trim();
    if (!comment) return ta.focus();
    send.disabled = true;
    send.textContent = "Sending…";
    try {
      await fetch(ENDPOINT + "/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: lastInput, target, comment }),
      });
      container.innerHTML = `<span class="fb-thanks">✓ Thanks — your feedback was recorded.</span>`;
    } catch {
      send.disabled = false;
      send.textContent = "Send feedback";
      ta.insertAdjacentHTML("afterend", `<span class="fb-thanks" style="color:#dc2626">Couldn't send — try again.</span>`);
    }
  });
}

function renderProfile(p) {
  $("src-name").textContent = p.name || "Profile";
  $("src-sub").textContent = [p.current_role, p.current_company, p.location].filter(Boolean).join(" · ");
  $("src-arc").textContent = p.arc || p.company_description || "";
  const chips = $("src-traits");
  chips.innerHTML = "";
  (p.traits || []).forEach((t) => {
    const w = t.weight != null ? `<span class="w">${pct(t.weight)}</span>` : "";
    chips.appendChild(el("span", "chip", `${esc(t.value || t)}${w}`));
  });
  renderLinks($("src-links"), p);
  renderFeedback($("src-fb"), `source: ${p.name || lastInput}`);
  $("source").classList.remove("is-hidden");
}

function renderMatches(matches) {
  const grid = $("results");
  grid.innerHTML = "";
  matches.forEach((m, i) => {
    const card = el("div", "card match" + (i === 0 ? " top" : ""));
    card.style.animationDelay = i * 0.08 + "s";

    if (i === 0) card.appendChild(el("div", "match-badge", "★ Top match"));

    const head = el("div", "match-head");
    head.appendChild(
      el("div", null,
        `<h3 class="match-name">${esc(m.name)}</h3>
         <p class="match-role">${esc([m.role, m.company].filter(Boolean).join(" · "))}</p>`)
    );
    head.appendChild(scoreRing(m.score));
    card.appendChild(head);

    if (m.arc) card.appendChild(el("p", "match-arc", esc(m.arc)));

    if (m.axes && m.axes.length) {
      const axes = el("div", "axes");
      m.axes.forEach((a) => {
        const row = el("div", "axis");
        row.appendChild(el("div", "axis-top", `<span>${esc(a.axis)}</span><span>${pct(a.score)}</span>`));
        const bar = el("div", "axis-bar");
        const fill = el("div", "axis-fill");
        bar.appendChild(fill);
        row.appendChild(bar);
        axes.appendChild(row);
        requestAnimationFrame(() => (fill.style.width = pct(a.score) + "%"));
      });
      card.appendChild(axes);
    }

    if (m.note) card.appendChild(el("p", "match-note", `<b>Why:</b> ${esc(m.note)}`));

    const links = el("div", "links");
    renderLinks(links, m);
    card.appendChild(links);

    const fb = el("div", "fb");
    renderFeedback(fb, m.name);
    card.appendChild(fb);

    grid.appendChild(card);
  });
  $("results-wrap").classList.remove("is-hidden");
}

function showNotice(html, isError) {
  const n = $("notice");
  n.innerHTML = html;
  n.className = "notice" + (isError ? " error" : "");
}

function handleEvent(ev) {
  switch (ev.type) {
    case "stage": setStep(ev.step, ev.state || "active"); break;
    case "status": $("status").textContent = ev.text || ""; break;
    case "profile": renderProfile(ev.profile); break;
    case "results": renderMatches(ev.matches || []); break;
    case "quota":
      if (ev.remaining != null)
        $("quota").textContent = `${ev.remaining} lookup${ev.remaining === 1 ? "" : "s"} left today`;
      break;
    case "error":
      $("spinner").style.display = "none";
      $("status").textContent = "";
      showNotice(`<b>Couldn't finish:</b> ${esc(ev.message)}`, true);
      break;
  }
}

async function run(input) {
  if (running || !input.trim()) return;
  running = true;
  lastInput = input.trim();
  const go = $("go");
  go.disabled = true;
  go.classList.add("loading");
  $("go-label").textContent = "Finding…";
  $("notice").className = "notice is-hidden";
  $("source").classList.add("is-hidden");
  $("results-wrap").classList.add("is-hidden");
  $("stage").classList.remove("is-hidden");
  $("spinner").style.display = "";
  buildStepper();
  $("status").textContent = "Starting — reconstructing the profile from the open web…";
  // make it obvious something is happening on Enter
  $("stage").scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const res = await fetch(ENDPOINT + "/lookalike", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: lastInput }),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      $("stage").classList.add("is-hidden");
      showNotice(
        `<b>Daily limit reached.</b> You've used your lookups for today${
          body.resetHint ? " — " + esc(body.resetHint) : ""
        }. This keeps the lab free for everyone. Come back tomorrow.`
      );
      return;
    }
    if (!res.ok || !res.body) throw new Error(`Server returned ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.replace(/^data:\s?/, "").trim();
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch (_) {}
      }
    }
    $("spinner").style.display = "none";
    if (!$("results-wrap").classList.contains("is-hidden")) {
      $("status").textContent = "Done — your closest matches are below.";
      $("results-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      $("status").textContent = "";
    }
  } catch (err) {
    showNotice(
      `<b>Something went wrong:</b> ${esc(err.message)}. The Worker may be down or not yet configured.`,
      true
    );
  } finally {
    running = false;
    const go = $("go");
    go.disabled = false;
    go.classList.remove("loading");
    $("go-label").textContent = "Find Lookalikes →";
    $("spinner").style.display = "none";
  }
}

$("go").addEventListener("click", () => run($("input").value));
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter") run($("input").value); });
