-- Add content column to documents table for extracted text
ALTER TABLE public.documents 
ADD COLUMN content TEXT;