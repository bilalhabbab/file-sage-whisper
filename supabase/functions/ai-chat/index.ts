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
    const openAIApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openAIApiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

    const { message, sessionId, documents } = await req.json();
    
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

    // Create or get chat session
    let chatSessionId = sessionId;
    if (!chatSessionId) {
      const { data: session, error: sessionError } = await supabase
        .from('chat_sessions')
        .insert({
          user_id: user.id,
          title: message.substring(0, 50) + (message.length > 50 ? '...' : '')
        })
        .select()
        .single();

      if (sessionError) {
        console.error('Session creation error:', sessionError);
        throw new Error('Failed to create chat session');
      }
      chatSessionId = session.id;
    }

    // Store user message
    const { error: userMessageError } = await supabase
      .from('chat_messages')
      .insert({
        session_id: chatSessionId,
        user_id: user.id,
        role: 'user',
        content: message
      });

    if (userMessageError) {
      console.error('User message error:', userMessageError);
      throw new Error('Failed to store user message');
    }

    // Prepare context from documents if available
    let documentContext = '';
    let hasDocumentContent = false;
    
    if (documents && documents.length > 0) {
      const documentsWithContent = documents.filter((doc: any) => doc.content && doc.content.trim());
      
      if (documentsWithContent.length > 0) {
        hasDocumentContent = true;
        documentContext = `\n\nHere are the uploaded documents:\n${documentsWithContent.map((doc: any) => 
          `Document: ${doc.name}\nContent: ${doc.content}`
        ).join('\n\n')}`;
      } else {
        documentContext = `\n\nDocuments uploaded: ${documents.map((doc: any) => doc.name).join(', ')}, but content extraction is still in progress or failed.`;
      }
    }

    // Enhanced system prompt that mirrors the Python approach
    const systemPrompt = `You are a helpful AI assistant for WSA Document Management. You analyze documents and provide insights, summaries, and answer questions about their content.

When users ask about their documents, provide detailed analysis including:
- Key information and main points
- Summaries when requested
- Specific answers to user questions
- Professional insights about the document content

If no document content is available, let users know they need to upload documents first.${documentContext}`;

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-2025-04-14',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: hasDocumentContent ? 
            `Here is my question about the documents: ${message}` : 
            message 
          }
        ],
        max_completion_tokens: 2000,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    // Store assistant message
    const { error: assistantMessageError } = await supabase
      .from('chat_messages')
      .insert({
        session_id: chatSessionId,
        user_id: user.id,
        role: 'assistant',
        content: assistantMessage
      });

    if (assistantMessageError) {
      console.error('Assistant message error:', assistantMessageError);
      throw new Error('Failed to store assistant message');
    }

    return new Response(JSON.stringify({ 
      message: assistantMessage,
      sessionId: chatSessionId
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in ai-chat function:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});