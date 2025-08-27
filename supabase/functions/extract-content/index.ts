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
        // For PDF files, we'll use a simple text extraction
        // Note: This is a basic implementation - for production use a proper PDF parser
        const arrayBuffer = await fileData.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const text = new TextDecoder().decode(uint8Array);
        
        // Basic PDF text extraction (this is very rudimentary)
        // In a real implementation, you'd use a proper PDF parsing library
        const textMatches = text.match(/\(([^)]+)\)/g) || [];
        extractedContent = textMatches
          .map(match => match.slice(1, -1))
          .filter(text => text.length > 2 && /[a-zA-Z]/.test(text))
          .join(' ');
        
        if (!extractedContent.trim()) {
          extractedContent = 'PDF content extraction not available - file appears to be image-based or encrypted';
        }
      } catch (error) {
        console.error('PDF extraction error:', error);
        extractedContent = 'Failed to extract PDF content';
      }
    } else if (filePath.toLowerCase().endsWith('.txt')) {
      // For text files
      extractedContent = await fileData.text();
    } else {
      extractedContent = 'Content extraction not supported for this file type';
    }

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