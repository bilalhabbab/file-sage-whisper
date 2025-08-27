// supabase/functions/extract-content/index.ts
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";
import * as pdfjsLib from "https://esm.sh/pdfjs-dist@4.7.76/legacy/build/pdf.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function clean(s: string) {
  return s.replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    // auth
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const token = auth.slice("Bearer ".length).trim();
    const { data: userRes, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userRes?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const user = userRes.user;

    // body
    let body: any;
    try { body = await req.json(); } catch { body = null; }
    const documentId = body?.documentId;
    const filePath = (body?.filePath || "").replace(/^\/+/, "");
    if (!documentId || !filePath) {
      return new Response(JSON.stringify({ error: "Missing documentId or filePath" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // download
    const { data: fileData, error: dlErr } = await supabase.storage.from("documents").download(filePath);
    if (dlErr) {
      console.error("Download error:", dlErr);
      return new Response(JSON.stringify({ error: "Failed to download file" }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // extract
    let content = "";
    const lower = filePath.toLowerCase();

    if (lower.endsWith(".pdf")) {
      try {
        // Edge-safe: run pdf.js without a worker
        // @ts-ignore
        pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;
        const buf = new Uint8Array(await fileData.arrayBuffer());
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          const txt = tc.items.map((it: any) => (typeof it?.str === "string" ? it.str : "")).join(" ");
          pages.push(txt);
        }
        content = clean(pages.join("\n\n")).slice(0, 50_000);
        if (!content) content = "This PDF appears to be image-based or contains non-extractable text. Consider OCR.";
      } catch (e) {
        console.error("PDF.js extraction error:", e);
        content = "Failed to extract PDF content - the file may be corrupted or encrypted.";
      }
    } else if (lower.endsWith(".txt")) {
      const raw = await fileData.text();
      content = clean(raw).slice(0, 50_000);
    } else {
      content = "Content extraction not supported for this file type. Supported types: PDF, TXT";
    }

    // save
    const { error: upErr, data: upData } = await supabase
      .from("documents")
      .update({ content, extraction_status: "complete" })
      .eq("id", documentId)
      .eq("user_id", user.id)
      .select("id");
    if (upErr) {
      console.error("Update error:", upErr);
      return new Response(JSON.stringify({ error: "Failed to save extracted content" }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!upData?.length) {
      return new Response(JSON.stringify({ error: "Document not found for this user" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, content }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("Unhandled error:", e);
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});