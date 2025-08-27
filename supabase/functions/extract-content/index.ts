import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.0";

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
        // For PDF files - basic text extraction with proper cleaning
        const arrayBuffer = await fileData.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Convert to string and clean up
        let rawText = '';
        for (let i = 0; i < uint8Array.length; i++) {
          const byte = uint8Array[i];
          // Only include printable ASCII characters and common whitespace
          if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9) {
            rawText += String.fromCharCode(byte);
          }
        }
        
        // Extract readable text patterns
        const textMatches = rawText.match(/[A-Za-z][A-Za-z0-9\s.,!?;:'"()[\]{}\-_@#$%^&*+=<>\/\\]{10,}/g) || [];
        extractedContent = textMatches
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 50000); // Limit to 50k characters
        
        if (!extractedContent.trim()) {
          extractedContent = 'This PDF appears to be image-based or contains content that cannot be extracted as text. Consider using OCR tools for better content extraction.';
        }
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