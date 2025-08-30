// supabase/functions/extract-content/index.ts
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";
import * as pdfjsLib from "https://esm.sh/pdfjs-dist@4.7.76/legacy/build/pdf.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_OUTPUT_CHARS = 50_000;
const MAX_PDF_PAGES = 1_000;          // hard ceiling for safety
const SOFT_PDF_PAGES_LIMIT = 400;     // stop early for massive PDFs
const OP_TIMEOUT_MS = 60_000;         // guard long parses (1 min)

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...CORS },
    ...init,
  });
}

function clean(s: string) {
  return s
    .replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
    .replace(/[ \t]+\n/g, "\n") // trim trailing spaces before newlines
    .replace(/\n{3,}/g, "\n\n") // collapse >2 newlines
    .replace(/[ \t]{2,}/g, " ") // collapse long runs of spaces
    .trim();
}

/** Save extraction result with status. */
async function saveExtraction(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  documentId: string,
  content: string,
  status: "complete" | "failed",
  failure_reason?: string,
) {
  const payload: Record<string, unknown> = {
    extraction_status: status,
  };
  if (status === "complete") payload.content = content;
  if (failure_reason) payload.failure_reason = failure_reason.slice(0, 500);

  return await supabase
    .from("documents")
    .update(payload)
    .eq("id", documentId)
    .eq("user_id", userId)
    .select("id")
    .single();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, { status: 405 });

  // --- ENV ---
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // --- AUTH ---
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return json({ error: "No authorization header" }, { status: 401 });
  }
  const token = auth.slice("Bearer ".length).trim();
  const { data: userRes, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userRes?.user) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = userRes.user;

  // --- BODY ---
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, { status: 400 }); }
  const documentId = body?.documentId;
  const filePathRaw = body?.filePath;
  if (typeof documentId !== "string" || !documentId) {
    return json({ error: "Missing 'documentId' (string)" }, { status: 400 });
  }
  if (typeof filePathRaw !== "string" || !filePathRaw) {
    return json({ error: "Missing 'filePath' (string)" }, { status: 400 });
  }
  const filePath = filePathRaw.replace(/^\/+/, "");
  const lower = filePath.toLowerCase();

  // --- DOWNLOAD ---
  const { data: fileData, error: dlErr } = await supabase.storage.from("documents").download(filePath);
  if (dlErr) {
    console.error("Download error:", dlErr);
    // Mark failed
    await saveExtraction(supabase, user.id, documentId, "", "failed", "Failed to download file");
    return json({ error: "Failed to download file" }, { status: 502 });
  }

  // --- TIMEOUT GUARD ---
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort("Operation timed out"), OP_TIMEOUT_MS);

  // --- EXTRACT ---
  let content = "";
  let failure_reason: string | undefined;

  try {
    if (lower.endsWith(".pdf")) {
      // @ts-ignore Edge-safe: no worker
      pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;
      const buf = new Uint8Array(await fileData.arrayBuffer());
      let doc;
      try {
        doc = await pdfjsLib.getDocument({ data: buf }).promise;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/password|encrypted/i.test(msg)) {
          failure_reason = "Encrypted or password-protected PDF not supported.";
        } else {
          failure_reason = "Unable to open PDF (possibly corrupted).";
        }
        throw new Error(failure_reason);
      }

      if (doc.numPages > MAX_PDF_PAGES) {
        failure_reason = `PDF has ${doc.numPages} pages (limit ${MAX_PDF_PAGES}).`;
        throw new Error(failure_reason);
      }

      const pages: string[] = [];
      const cap = Math.min(doc.numPages, SOFT_PDF_PAGES_LIMIT);
      for (let i = 1; i <= cap; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        // Keep simple line breaks when font size drops or x goes backward
        // (pdf.js positions items; here we do a light heuristic)
        let line = "";
        let lastX = 0;
        let lastY = 0;
        for (const it of tc.items as any[]) {
          const s = typeof it?.str === "string" ? it.str : "";
          if (!s) continue;
          const trm = it?.transform as number[] | undefined;
          const x = trm ? trm[4] : lastX;
          const y = trm ? trm[5] : lastY;
          const newLine = y !== lastY && Math.abs(y - lastY) > 2;
          const backtrack = x < lastX - 2;
          if (newLine || backtrack) {
            line = line.trimEnd();
            if (line) pages.push(line);
            line = s;
          } else {
            line += (line ? " " : "") + s;
          }
          lastX = x;
          lastY = y;
        }
        if (line) pages.push(line.trimEnd());
        pages.push(""); // page break
      }
      if (cap < doc.numPages) {
        pages.push(`[Truncated at ${cap}/${doc.numPages} pages for size/performance.]`);
      }
      content = clean(pages.join("\n")).slice(0, MAX_OUTPUT_CHARS);
      if (!content) {
        content = "This PDF appears to be image-based or contains non-extractable text. Consider OCR.";
      }
    } else if (lower.endsWith(".txt") || lower.endsWith(".md")) {
      const raw = await fileData.text();
      content = clean(raw).slice(0, MAX_OUTPUT_CHARS);
    } else if (lower.endsWith(".csv")) {
      const raw = await fileData.text();
      // Keep CSV rows line-broken, but clean noisy whitespace
      const lines = raw.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").trimEnd());
      content = clean(lines.join("\n")).slice(0, MAX_OUTPUT_CHARS);
    } else if (lower.endsWith(".json")) {
      try {
        const obj = JSON.parse(await fileData.text());
        content = clean(JSON.stringify(obj, null, 2)).slice(0, MAX_OUTPUT_CHARS);
      } catch {
        content = clean(await fileData.text()).slice(0, MAX_OUTPUT_CHARS);
      }
    } else {
      content = "Content extraction not supported for this file type. Supported: PDF, TXT, MD, CSV, JSON";
    }
  } catch (e: any) {
    clearTimeout(t);
    const reason = failure_reason || String(e?.message ?? e);
    console.error("Extraction error:", reason);
    const { error: upErr } = await saveExtraction(supabase, user.id, documentId, "", "failed", reason);
    if (upErr) console.error("Status update error (failed):", upErr);
    return json({ error: reason }, { status: 422 });
  } finally {
    clearTimeout(t);
  }

  // --- SAVE ---
  const { error: upErr, data } = await saveExtraction(supabase, user.id, documentId, content, "complete");
  if (upErr) {
    console.error("Update error:", upErr);
    return json({ error: "Failed to save extracted content" }, { status: 500 });
  }
  if (!data?.id) {
    return json({ error: "Document not found for this user" }, { status: 404 });
  }

  return json({ success: true, content });
});