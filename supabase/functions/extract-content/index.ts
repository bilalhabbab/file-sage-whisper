import "https://deno.land/x/xhr@0.1.0/mod.ts"; // keep for supabase-js
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";
import * as pdfjsLib from "https://esm.sh/pdfjs-dist@4.7.76/legacy/build/pdf.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { documentId, filePath } = await req.json();

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("No authorization header");

    const jwt = authHeader.replace("Bearer ", "").trim();
    const { data: userRes, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !userRes?.user) throw new Error("Unauthorized");
    const user = userRes.user;

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(filePath);
    if (downloadError) throw new Error("Failed to download file");

    let extractedContent = "";

    if (filePath.toLowerCase().endsWith(".pdf")) {
      // ---- PDF.js text extraction ----
      const arrayBuffer = await fileData.arrayBuffer();

      // PDF.js needs a worker disabled in edge (runs in same thread)
      pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;

      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
      const pdf = await loadingTask.promise;

      const texts: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((it: any) => ("str" in it ? it.str : ""))
          .join(" ");
        texts.push(pageText);
      }
      extractedContent = texts.join("\n\n");
      extractedContent = clean(extractedContent).slice(0, 50_000);

      if (!extractedContent.trim()) {
        extractedContent =
          "This PDF appears to be image-based or contains non-extractable text. Consider OCR.";
      }
    } else if (filePath.toLowerCase().endsWith(".txt")) {
      const rawText = await fileData.text();
      extractedContent = clean(rawText).slice(0, 50_000);
    } else {
      extractedContent =
        "Content extraction not supported for this file type. Supported types: PDF, TXT";
    }

    const { error: updateError } = await supabase
      .from("documents")
      .update({ content: extractedContent })
      .eq("id", documentId)
      .eq("user_id", user.id);

    if (updateError) throw new Error("Failed to save extracted content");

    return new Response(JSON.stringify({ success: true, content: extractedContent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error in extract-content function:", error);
    return new Response(JSON.stringify({ error: String(error?.message ?? error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Small utility to sanitize text
function clean(s: string) {
  return s
    .replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}