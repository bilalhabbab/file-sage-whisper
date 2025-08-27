// supabase/functions/extract-content/index.ts

// Polyfill XHR for supabase-js in Deno
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";
import * as pdfjsLib from "https://esm.sh/pdfjs-dist@4.7.76/legacy/build/pdf.mjs";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function clean(s: string) {
  return s
    .replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // --- Env ---
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // --- Auth ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const jwt = authHeader.slice("Bearer ".length).trim();
    const { data: userRes, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !userRes?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userRes.user;

    // --- Input ---
    let payload: any = null;
    try {
      payload = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const documentId: string | undefined = payload?.documentId;
    const filePathRaw: string | undefined = payload?.filePath;

    if (!documentId || !filePathRaw) {
      return new Response(JSON.stringify({ error: "Missing documentId or filePath" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Normalize path (remove leading slash if present)
    const filePath = filePathRaw.replace(/^\/+/, "");

    console.log("Extracting content", {
      documentId,
      userId: user.id,
      filePath,
    });

    // --- Download ---
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(filePath);

    if (downloadError) {
      console.error("Download error:", downloadError);
      return new Response(JSON.stringify({ error: "Failed to download file" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Extract ---
    let extractedContent = "";
    const lower = filePath.toLowerCase();

    if (lower.endsWith(".pdf")) {
      try {
        // PDF.js single-thread mode for edge
        // @ts-ignore - pdfjs type in esm build
        pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;

        const arrayBuffer = await fileData.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        const pdf = await loadingTask.promise;

        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const text = content.items
            .map((it: any) => (typeof it?.str === "string" ? it.str : ""))
            .join(" ");
          pages.push(text);
        }
        extractedContent = clean(pages.join("\n\n")).slice(0, 50_000);

        if (!extractedContent) {
          extractedContent =
            "This PDF appears to be image-based or contains non-extractable text. Consider OCR.";
        }
      } catch (e) {
        console.error("PDF.js extraction error:", e);
        extractedContent = "Failed to extract PDF content - the file may be corrupted or encrypted.";
      }
    } else if (lower.endsWith(".txt")) {
      try {
        const raw = await fileData.text();
        extractedContent = clean(raw).slice(0, 50_000);
      } catch (e) {
        console.error("TXT read error:", e);
        extractedContent = "Failed to read text file.";
      }
    } else {
      extractedContent =
        "Content extraction not supported for this file type. Supported types: PDF, TXT";
    }

    // --- Save to DB ---
    const { error: updateError, data: updateData } = await supabase
      .from("documents")
      .update({ content: extractedContent })
      .eq("id", documentId)
      .eq("user_id", user.id)
      .select("id");

    if (updateError) {
      console.error("Update error:", updateError);
      return new Response(JSON.stringify({ error: "Failed to save extracted content" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!updateData || updateData.length === 0) {
      // Matched zero rows — likely wrong documentId or user_id
      console.warn("Update matched zero rows", { documentId, userId: user.id });
      return new Response(JSON.stringify({ error: "Document not found for this user" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Extraction saved", { documentId });

    return new Response(
      JSON.stringify({ success: true, content: extractedContent }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("Unhandled error in extract-content:", error);
    return new Response(JSON.stringify({ error: String(error?.message ?? error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});