import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";
import * as pdfParse from "https://esm.sh/pdf-parse@1.1.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const { documentId, filePath } = await req.json();
    
    // Get auth header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    // Get user from JWT
    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    
    if (authError || !user) {
      throw new Error('Unauthorized');
    }

    console.log('Extracting content for document:', documentId, filePath);

    // Download file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('documents')
      .download(filePath);

    if (downloadError) {
      console.error('Download error:', downloadError);
      throw new Error('Failed to download file');
    }

    let extractedContent = '';

    // Extract content based on file type
    if (filePath.toLowerCase().endsWith('.pdf')) {
      try {
        console.log('Starting PDF text extraction with pdf-parse...');
        
        // Use pdf-parse library similar to PyPDF2
        const arrayBuffer = await fileData.arrayBuffer();
        const buffer = new Uint8Array(arrayBuffer);
        
        const pdfData = await pdfParse(buffer);
        extractedContent = pdfData.text
          .replace(/\0/g, '') // Remove null bytes
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
          .replace(/\s+/g, ' ') // Normalize whitespace
          .trim()
          .substring(0, 50000); // Limit to 50k characters
        
        if (!extractedContent.trim()) {
          extractedContent = 'This PDF appears to be image-based or contains content that cannot be extracted as text. Consider using OCR tools for better content extraction.';
        }
        
        console.log(`PDF extraction successful, extracted ${extractedContent.length} characters`);
      } catch (error) {
        console.error('PDF extraction error:', error);
        extractedContent = 'Failed to extract PDF content - the file may be corrupted or encrypted.';
      }
    } else if (filePath.toLowerCase().endsWith('.txt')) {
      // For text files - clean and limit content
      const rawText = await fileData.text();
      extractedContent = rawText
        .replace(/\0/g, '') // Remove null bytes
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
        .trim()
        .substring(0, 50000); // Limit to 50k characters
    } else {
      extractedContent = 'Content extraction not supported for this file type. Supported types: PDF, TXT';
    }

    // Final cleanup to ensure database compatibility
    extractedContent = extractedContent
      .replace(/\0/g, '') // Remove any remaining null bytes
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
      .trim();

    // Update document with extracted content
    const { error: updateError } = await supabase
      .from('documents')
      .update({ content: extractedContent })
      .eq('id', documentId)
      .eq('user_id', user.id);

    if (updateError) {
      console.error('Update error:', updateError);
      throw new Error('Failed to save extracted content');
    }

    console.log('Content extracted and saved for document:', documentId);

    return new Response(JSON.stringify({ 
      success: true,
      content: extractedContent
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in extract-content function:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});