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
    if (documents && documents.length > 0) {
      const documentsWithContent = documents.filter(doc => doc.content && doc.content.trim() !== '');
      if (documentsWithContent.length > 0) {
        documentContext = `\n\nHere are the uploaded documents and their content:\n\n${documentsWithContent.map((doc: any) => 
          `Document: ${doc.name}\n\nContent:\n${doc.content}`
        ).join('\n\n---\n\n')}`;
      } else {
        documentContext = `\n\nDocuments uploaded: ${documents.map(d => d.name).join(', ')}\nNote: Content extraction may still be in progress for these documents.`;
      }
    }

    const systemPrompt = `You are a helpful AI assistant for WSA Document Management. You help users with questions about their uploaded documents and provide general assistance. 

If users ask about their documents, provide helpful insights and analysis. If no document context is provided, let them know you can help better once they upload relevant documents.${documentContext}`;

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: 1000,
        temperature: 0.7,
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