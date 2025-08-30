// supabase/functions/extract-content/index.ts
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";

// ⚠️ Replace pdfjs-dist with unpdf (serverless-friendly PDF.js)
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@1.2.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_OUTPUT_CHARS = 50_000;
const OP_TIMEOUT_MS = 60_000;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...CORS },
    ...init,
  });
}

function clean(s: string) {
  return s
    .replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Save extraction result with status + optional reason. */
async function saveExtraction(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  documentId: string,
  content: string,
  status: "complete" | "failed",
  failure_reason?: string,
) {
  const payload: Record<string, unknown> = { extraction_status: status };
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
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
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
    await saveExtraction(supabase, user.id, documentId, "", "failed", "Failed to download file");
    return json({ error: "Failed to download file" }, { status: 502 });
  }

  // --- TIMEOUT GUARD ---
  let timeoutId: number | undefined;
  const timed = <T>(p: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Operation timed out")), OP_TIMEOUT_MS) as unknown as number;
      p.then((v) => { clearTimeout(timeoutId); resolve(v); })
       .catch((e) => { clearTimeout(timeoutId); reject(e); });
    });

  // --- EXTRACT ---
  let content = "";
  let failure_reason: string | undefined;

  try {
    if (lower.endsWith(".pdf")) {
      const buf = new Uint8Array(await fileData.arrayBuffer());

      // Use unpdf's serverless PDF.js pipeline
      const pdf = await timed(getDocumentProxy(buf));

      // Returns a single combined text + totalPages
      const { text, totalPages } = await timed(extractText(pdf, { mergePages: true }));

      content = clean(text).slice(0, MAX_OUTPUT_CHARS);
      if (!content) {
        content = `This PDF appears to be image-based (no embedded text). Consider OCR and re-upload. Pages: ${totalPages}`;
      }
    } else if (lower.endsWith(".txt") || lower.endsWith(".md")) {
      const raw = await fileData.text();
      content = clean(raw).slice(0, MAX_OUTPUT_CHARS);
    } else if (lower.endsWith(".csv")) {
      const raw = await fileData.text();
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
    const reason = failure_reason || String(e?.message ?? e);
    console.error("Extraction error:", reason);
    const { error: upErr } = await saveExtraction(supabase, user.id, documentId, "", "failed", reason);
    if (upErr) console.error("Status update error (failed):", upErr);
    return json({ error: reason }, { status: 422 });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
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