import { useState } from "react";

// ─── Prompt Builder ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert workshop facilitator and agenda designer.
Your task is to generate a structured workshop agenda based on the user's inputs.

## Rules
- Return ONLY valid JSON. No prose, no markdown, no explanation before or after.
- The agenda blocks must sum exactly to the total duration in minutes.
- Start time is always 09:00 unless the user specifies otherwise.
- Include a short energiser or warm-up as the first block (max 15% of total time).
- Include at least one break for sessions longer than 90 minutes.
- Always end with a closing/reflection block (max 10% of total time).
- Match the energy and pacing to the requested energy level:
    - "high-energy" → shorter blocks, more activities, fast pace
    - "focused" → longer working blocks, fewer transitions
    - "reflective" → slower pace, more journaling/discussion time
- Adapt activity types to the workshop type:
    - "discovery" → interviews, mapping, insight synthesis
    - "co-design" → sketching, prototyping, voting
    - "retrospective" → reflection prompts, dot voting, action planning
    - "ideation" → brainstorming, SCAMPER, crazy 8s, concept sorting
- facilitationNotes must be practical, facilitator-facing tips (not descriptions).
- materials must be physical or digital items actually needed (not generic advice).

## Output schema — return exactly this structure:
{
  "summary": {
    "goal": string,
    "audience": string,
    "participantCount": number,
    "duration": string,
    "workshopType": string,
    "energyLevel": string
  },
  "agenda": [
    {
      "id": string,
      "startTime": string,
      "durationMinutes": number,
      "phase": string,
      "title": string,
      "description": string,
      "facilitationNotes": string,
      "materials": string[]
    }
  ]
}`;

const buildUserPrompt = (form) => `Generate a workshop agenda with the following inputs:
- Goal / Objective: ${form.goal}
- Target Audience: ${form.audience}
- Number of Participants: ${form.participantCount}
- Total Duration: ${form.duration} minutes
- Workshop Type: ${form.workshopType}
- Energy Level / Tone: ${form.energyLevel}`;

// ─── Validation Layer ─────────────────────────────────────────────────────────
const VALID_PHASES = ["opening", "energiser", "main", "break", "closing"];

const validateAgenda = (parsed, totalMinutes) => {
  if (!parsed.summary || !Array.isArray(parsed.agenda) || parsed.agenda.length === 0)
    throw new Error("Invalid structure: missing summary or agenda.");
  const sum = parsed.agenda.reduce((acc, b) => acc + b.durationMinutes, 0);
  if (Math.abs(sum - totalMinutes) > 5)
    throw new Error(`Duration mismatch: blocks sum to ${sum} min, expected ${totalMinutes} min.`);
  parsed.agenda.forEach((block, i) => {
    const required = ["id","startTime","durationMinutes","phase","title","description","facilitationNotes","materials"];
    required.forEach((key) => {
      if (block[key] === undefined) throw new Error(`Block ${i} missing field: ${key}`);
    });
    if (!VALID_PHASES.includes(block.phase))
      throw new Error(`Block ${i} has invalid phase: ${block.phase}`);
  });
  return parsed;
};

// ─── API Call ─────────────────────────────────────────────────────────────────
const stripMarkdownFences = (raw) => {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
};

const withRetry = async (fn, maxAttempts = 3) => {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt} failed:`, err.message);
    }
  }
  throw lastError;
};

const generateAgenda = async (form) => {
  const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
  if (!apiKey) throw new Error("No API key found. Add VITE_OPENAI_API_KEY to your .env file.");

  return withRetry(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          temperature: 0.7,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(form) },
          ],
        }),
      });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Request timed out. Please try again.");
      throw new Error("Network error. Check your connection and try again.");
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401) throw new Error("Invalid API key. Check your VITE_OPENAI_API_KEY.");
    if (response.status === 429) throw new Error("Rate limit reached. Wait a moment and try again.");
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const data = await response.json();
    const raw = data.choices[0].message.content.trim();
    const cleaned = stripMarkdownFences(raw);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("The AI returned malformed JSON. Retrying…");
    }

    return validateAgenda(parsed, Number(form.duration));
  }, 3);
};

// ─── FormField ────────────────────────────────────────────────────────────────
const FormField = ({ label, required, error, children }) => (
  <div className="flex flex-col gap-1">
    <label className="text-sm font-semibold text-gray-700">
      {label} {required && <span className="text-rose-500">*</span>}
    </label>
    {children}
    {error && <p className="text-xs text-rose-500 mt-0.5">{error}</p>}
  </div>
);

// ─── DurationPicker ───────────────────────────────────────────────────────────
const DurationPicker = ({ value, onChange, error }) => {
  const presets = [
    { label: "1 hour", value: "60" },
    { label: "90 min", value: "90" },
    { label: "2 hours", value: "120" },
    { label: "Half day", value: "210" },
    { label: "Full day", value: "420" },
  ];
  const [custom, setCustom] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => { setCustom(false); onChange(p.value); }}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
              value === p.value && !custom
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-white text-gray-600 border-gray-300 hover:border-indigo-400"
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setCustom(true); onChange(""); }}
          className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
            custom
              ? "bg-indigo-600 text-white border-indigo-600"
              : "bg-white text-gray-600 border-gray-300 hover:border-indigo-400"
          }`}
        >
          Custom
        </button>
      </div>
      {custom && (
        <input
          type="number"
          min="30"
          max="480"
          placeholder="Duration in minutes (e.g. 150)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
            error ? "border-rose-400" : "border-gray-300"
          }`}
        />
      )}
      {error && <p className="text-xs text-rose-500">{error}</p>}
    </div>
  );
};

// ─── EnergySelector ───────────────────────────────────────────────────────────
const EnergySelector = ({ value, onChange, error }) => {
  const options = [
    { value: "high-energy", label: "⚡ High Energy", desc: "Fast pace, lots of activities" },
    { value: "focused", label: "🎯 Focused", desc: "Deep work, longer blocks" },
    { value: "reflective", label: "🌿 Reflective", desc: "Slower pace, discussion-heavy" },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`flex flex-col items-start gap-1 px-4 py-3 rounded-xl border-2 text-left transition-all ${
              value === opt.value
                ? "border-indigo-500 bg-indigo-50"
                : "border-gray-200 bg-white hover:border-indigo-300"
            }`}
          >
            <span className="text-sm font-semibold text-gray-800">{opt.label}</span>
            <span className="text-xs text-gray-500">{opt.desc}</span>
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-rose-500">{error}</p>}
    </div>
  );
};

// ─── Phase color map ──────────────────────────────────────────────────────────
const PHASE_STYLES = {
  opening:   { bg: "bg-blue-50",   border: "border-blue-200",   badge: "bg-blue-100 text-blue-700",   dot: "bg-blue-400" },
  energiser: { bg: "bg-yellow-50", border: "border-yellow-200", badge: "bg-yellow-100 text-yellow-700", dot: "bg-yellow-400" },
  main:      { bg: "bg-indigo-50", border: "border-indigo-200", badge: "bg-indigo-100 text-indigo-700", dot: "bg-indigo-400" },
  break:     { bg: "bg-gray-50",   border: "border-gray-200",   badge: "bg-gray-100 text-gray-500",    dot: "bg-gray-300" },
  closing:   { bg: "bg-green-50",  border: "border-green-200",  badge: "bg-green-100 text-green-700",  dot: "bg-green-400" },
};

// ─── AgendaBlock ──────────────────────────────────────────────────────────────
const AgendaBlock = ({ block }) => {
  const [open, setOpen] = useState(false);
  const style = PHASE_STYLES[block.phase] || PHASE_STYLES.main;

  return (
    <div className={`rounded-xl border ${style.border} ${style.bg} p-4 flex flex-col gap-2 transition-all`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${style.dot}`} />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-gray-400">{block.startTime}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${style.badge}`}>{block.phase}</span>
              <span className="text-xs text-gray-400">{block.durationMinutes} min</span>
            </div>
            <p className="text-sm font-bold text-gray-900 mt-0.5">{block.title}</p>
          </div>
        </div>
        <button
          onClick={() => setOpen(!open)}
          className="text-xs text-indigo-500 hover:text-indigo-700 shrink-0 mt-1 font-medium"
        >
          {open ? "Hide ▲" : "Details ▼"}
        </button>
      </div>
      <p className="text-xs text-gray-600 ml-5">{block.description}</p>
      {open && (
        <div className="ml-5 flex flex-col gap-3 mt-1">
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">🎙 Facilitation Notes</p>
            <p className="text-xs text-gray-600 leading-relaxed">{block.facilitationNotes}</p>
          </div>
          {block.materials?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">📦 Materials</p>
              <div className="flex flex-wrap gap-1.5">
                {block.materials.map((m, i) => (
                  <span key={i} className="text-xs bg-white border border-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{m}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── SummaryHeader ────────────────────────────────────────────────────────────
const SummaryHeader = ({ summary }) => {
  const pills = [
    { icon: "🎯", label: summary.workshopType },
    { icon: "👥", label: `${summary.participantCount} participants` },
    { icon: "⏱", label: `${summary.duration} min` },
    { icon: "⚡", label: summary.energyLevel },
  ];
  return (
    <div className="bg-indigo-600 rounded-2xl p-6 text-white mb-6">
      <p className="text-indigo-200 text-xs font-semibold uppercase tracking-widest mb-1">Workshop Goal</p>
      <h2 className="text-lg font-bold leading-snug mb-3">{summary.goal}</h2>
      <p className="text-indigo-200 text-sm mb-4">👤 {summary.audience}</p>
      <div className="flex flex-wrap gap-2">
        {pills.map((p, i) => (
          <span key={i} className="text-xs bg-white/20 text-white px-3 py-1 rounded-full font-medium">
            {p.icon} {p.label}
          </span>
        ))}
      </div>
    </div>
  );
};

// ─── AgendaTimeline ───────────────────────────────────────────────────────────
const AgendaTimeline = ({ agenda }) => (
  <div className="flex flex-col gap-3">
    {agenda.map((block) => (
      <AgendaBlock key={block.id} block={block} />
    ))}
  </div>
);

// ─── Export helpers ───────────────────────────────────────────────────────────
const buildExportText = (agenda) => {
  const s = agenda.summary;
  const header = [
    "WORKSHOP AGENDA",
    "═".repeat(40),
    `Goal:         ${s.goal}`,
    `Audience:     ${s.audience}`,
    `Participants: ${s.participantCount}`,
    `Duration:     ${s.duration} min`,
    `Type:         ${s.workshopType}`,
    `Energy:       ${s.energyLevel}`,
    "═".repeat(40),
    "",
  ].join("\n");

  const blocks = agenda.agenda.map((b) => [
    `${b.startTime}  ${b.title} (${b.durationMinutes} min) [${b.phase}]`,
    `${b.description}`,
    `Facilitation: ${b.facilitationNotes}`,
    b.materials.length > 0 ? `Materials: ${b.materials.join(", ")}` : "",
    "",
  ].filter(Boolean).join("\n")).join("\n");

  return header + blocks;
};

const downloadTxt = (agenda) => {
  const text = buildExportText(agenda);
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "workshop-agenda.txt";
  a.click();
  URL.revokeObjectURL(url);
};

// ─── ActionBar ────────────────────────────────────────────────────────────────
const ActionBar = ({ agenda, onEdit, onRegenerate }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = buildExportText(agenda);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex flex-wrap gap-3 mt-6 print:hidden">
      <button onClick={handleCopy} className="flex-1 min-w-[120px] bg-white border border-gray-200 hover:border-indigo-400 text-gray-700 text-sm font-medium py-2.5 rounded-xl transition-all">
        {copied ? "✅ Copied!" : "📋 Copy agenda"}
      </button>
      <button onClick={() => downloadTxt(agenda)} className="flex-1 min-w-[120px] bg-white border border-gray-200 hover:border-indigo-400 text-gray-700 text-sm font-medium py-2.5 rounded-xl transition-all">
        ⬇️ Download .txt
      </button>
      <button onClick={() => window.print()} className="flex-1 min-w-[120px] bg-white border border-gray-200 hover:border-indigo-400 text-gray-700 text-sm font-medium py-2.5 rounded-xl transition-all">
        🖨️ Print
      </button>
      <button onClick={onRegenerate} className="flex-1 min-w-[120px] bg-white border border-gray-200 hover:border-indigo-400 text-gray-700 text-sm font-medium py-2.5 rounded-xl transition-all">
        🔄 Regenerate
      </button>
      <button onClick={onEdit} className="flex-1 min-w-[120px] bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold py-2.5 rounded-xl transition-all">
        ✏️ Edit inputs
      </button>
    </div>
  );
};

// ─── Empty State ──────────────────────────────────────────────────────────────
const EmptyState = ({ onEdit }) => (
  <div className="text-center py-16">
    <div className="text-4xl mb-3">📭</div>
    <p className="text-gray-600 font-semibold">No agenda blocks were returned.</p>
    <p className="text-gray-400 text-sm mt-1 mb-6">This can happen if the AI misunderstood the inputs.</p>
    <button onClick={onEdit} className="bg-indigo-600 text-white text-sm font-semibold px-6 py-2.5 rounded-xl hover:bg-indigo-700 transition-all">
      ✏️ Edit inputs and try again
    </button>
  </div>
);

// ─── AgendaOutput ─────────────────────────────────────────────────────────────
const AgendaOutput = ({ agenda, onEdit, onRegenerate }) => (
  <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-start justify-center px-4 py-12">
    <div className="w-full max-w-2xl">
      <div className="inline-flex items-center gap-2 bg-indigo-100 text-indigo-700 text-xs font-semibold px-3 py-1 rounded-full mb-4 print:hidden">
        🗓️ Workshop Agenda Builder
      </div>
      <SummaryHeader summary={agenda.summary} />
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Agenda</h3>
      {agenda.agenda.length === 0
        ? <EmptyState onEdit={onEdit} />
        : <AgendaTimeline agenda={agenda.agenda} />
      }
      <ActionBar agenda={agenda} onEdit={onEdit} onRegenerate={onRegenerate} />
      <p className="text-center text-xs text-gray-400 mt-8">
        Built with ❤️ · Workshop Agenda Builder · Your data is never stored.
      </p>
    </div>
  </div>
);

// ─── Loading Messages ─────────────────────────────────────────────────────────
const LOADING_MESSAGES = [
  "Building your agenda…",
  "Structuring the flow…",
  "Picking the right activities…",
  "Timing the blocks…",
  "Adding facilitation tips…",
  "Almost there…",
];

// ─── Loading State ────────────────────────────────────────────────────────────
const LoadingState = () => {
  const [msgIndex, setMsgIndex] = useState(0);

  useState(() => {
    const interval = setInterval(() => {
      setMsgIndex((i) => (i + 1) % LOADING_MESSAGES.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex flex-col items-center justify-center gap-6">
      <div className="w-12 h-12 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
      <div className="text-center">
        <p className="text-gray-800 font-semibold text-lg">{LOADING_MESSAGES[msgIndex]}</p>
        <p className="text-gray-400 text-sm mt-1">This usually takes 5–10 seconds</p>
      </div>
      <div className="flex flex-col gap-3 w-full max-w-md px-4">
        {["80", "60", "72", "52"].map((w, i) => (
          <div key={i} className="h-4 bg-gray-200 rounded-full animate-pulse" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
};

// ─── Error Banner ─────────────────────────────────────────────────────────────
const ErrorBanner = ({ message, onRetry }) => (
  <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-center justify-center px-4">
    <div className="bg-white border border-rose-200 rounded-2xl p-8 max-w-md w-full text-center shadow-sm">
      <div className="text-4xl mb-4">⚠️</div>
      <h2 className="text-gray-900 font-bold text-lg mb-2">Something went wrong</h2>
      <p className="text-gray-500 text-sm mb-6">{message}</p>
      <button onClick={onRetry} className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition-all">
        Try again
      </button>
    </div>
  </div>
);

// ─── App Shell ────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("form");
  const [formData, setFormData] = useState(null);
  const [agenda, setAgenda] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (form) => {
    setFormData(form);
    setView("loading");
    try {
      const result = await generateAgenda(form);
      setAgenda(result);
      setView("result");
    } catch (err) {
      setErrorMsg(err.message);
      setView("error");
    }
  };

  if (view === "loading") return <LoadingState />;
  if (view === "error") return <ErrorBanner message={errorMsg} onRetry={() => setView("form")} />;
  if (view === "result") return (
    <AgendaOutput
      agenda={agenda}
      onEdit={() => setView("form")}
      onRegenerate={() => handleSubmit(formData)}
    />
  );

  return <WorkshopForm onSubmit={handleSubmit} />;
}

// ─── WorkshopForm ─────────────────────────────────────────────────────────────
const WORKSHOP_TYPES = [
  { value: "discovery", label: "🔍 Discovery" },
  { value: "co-design", label: "✏️ Co-design" },
  { value: "retrospective", label: "🔁 Retrospective" },
  { value: "ideation", label: "💡 Ideation" },
];

const initialForm = {
  goal: "",
  audience: "",
  participantCount: "",
  duration: "",
  workshopType: "",
  energyLevel: "",
};

const validate = (form) => {
  const errors = {};
  if (!form.goal.trim()) errors.goal = "Please describe the workshop goal.";
  if (!form.audience.trim()) errors.audience = "Please describe the target audience.";
  if (!form.participantCount || isNaN(form.participantCount) || Number(form.participantCount) < 2)
    errors.participantCount = "Please enter a valid number (min 2).";
  if (!form.duration) errors.duration = "Please select or enter a duration.";
  if (!form.workshopType) errors.workshopType = "Please select a workshop type.";
  if (!form.energyLevel) errors.energyLevel = "Please select an energy level.";
  return errors;
};

function WorkshopForm({ onSubmit }) {
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});

  const set = (field) => (val) =>
    setForm((prev) => ({ ...prev, [field]: val }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate(form);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setErrors({});
    if (onSubmit) onSubmit(form);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 bg-indigo-100 text-indigo-700 text-xs font-semibold px-3 py-1 rounded-full mb-3">
            🗓️ Workshop Agenda Builder
          </div>
          <h1 className="text-3xl font-bold text-gray-900 leading-tight">Plan your workshop</h1>
          <p className="text-gray-500 mt-1 text-sm">Fill in the details below and we'll generate a full agenda for you in seconds.</p>
        </div>
        <form onSubmit={handleSubmit} noValidate>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sm:p-8 flex flex-col gap-6">
            <FormField label="Workshop Goal / Objective" required error={errors.goal}>
              <textarea rows={3} placeholder="e.g. Understand our users' main pain points around onboarding" value={form.goal} onChange={(e) => set("goal")(e.target.value)} className={`w-full px-3 py-2 rounded-lg border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-400 ${errors.goal ? "border-rose-400" : "border-gray-300"}`} />
            </FormField>
            <FormField label="Target Audience / Participants" required error={errors.audience}>
              <input type="text" placeholder="e.g. UX designers and product managers" value={form.audience} onChange={(e) => set("audience")(e.target.value)} className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ${errors.audience ? "border-rose-400" : "border-gray-300"}`} />
            </FormField>
            <FormField label="Number of Participants" required error={errors.participantCount}>
              <input type="number" min="2" max="200" placeholder="e.g. 12" value={form.participantCount} onChange={(e) => set("participantCount")(e.target.value)} className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ${errors.participantCount ? "border-rose-400" : "border-gray-300"}`} />
            </FormField>
            <FormField label="Total Duration" required>
              <DurationPicker value={form.duration} onChange={set("duration")} error={errors.duration} />
            </FormField>
            <FormField label="Workshop Type" required error={errors.workshopType}>
              <div className="flex flex-wrap gap-2">
                {WORKSHOP_TYPES.map((t) => (
                  <button key={t.value} type="button" onClick={() => set("workshopType")(t.value)} className={`px-4 py-2 rounded-full text-sm font-medium border transition-all ${form.workshopType === t.value ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-600 border-gray-300 hover:border-indigo-400"}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </FormField>
            <FormField label="Energy Level / Tone" required>
              <EnergySelector value={form.energyLevel} onChange={set("energyLevel")} error={errors.energyLevel} />
            </FormField>
            <div className="border-t border-gray-100" />
            <button type="submit" className="w-full bg-indigo-600 h
