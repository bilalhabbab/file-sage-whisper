import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/components/ui/use-toast';
import { Upload, File, X, CheckCircle } from 'lucide-react';

interface FileUploadProps {
  onUploadComplete?: () => void;
}

interface UploadingFile {
  file: File;
  progress: number;
  status: 'uploading' | 'complete' | 'error';
  id: string;
}

const FileUpload: React.FC<FileUploadProps> = ({ onUploadComplete }) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!user) {
      toast({
        title: "Error",
        description: "You must be logged in to upload files",
        variant: "destructive",
      });
      return;
    }

    // Add files to uploading state
    const newUploadingFiles = acceptedFiles.map(file => ({
      file,
      progress: 0,
      status: 'uploading' as const,
      id: crypto.randomUUID(),
    }));

    setUploadingFiles(prev => [...prev, ...newUploadingFiles]);

    // Upload each file
    for (const uploadingFile of newUploadingFiles) {
      await uploadFile(uploadingFile);
    }
  }, [user, toast]);

  const uploadFile = async (uploadingFile: UploadingFile) => {
    try {
      const { file, id } = uploadingFile;
      const fileExtension = file.name.split('.').pop();
      const fileName = `${user!.id}/${crypto.randomUUID()}.${fileExtension}`;

      // Upload file to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('documents')
        .upload(fileName, file);

      if (uploadError) {
        throw uploadError;
      }

      // Simulate progress completion
      setUploadingFiles(prev => 
        prev.map(f => f.id === id ? { ...f, progress: 100 } : f)
      );

      // Store file metadata in database
      const { data: document, error: dbError } = await supabase
        .from('documents')
        .insert({
          user_id: user!.id,
          name: file.name,
          file_path: uploadData.path,
          file_size: file.size,
          file_type: file.type,
        })
        .select()
        .single();

      if (dbError) {
        throw dbError;
      }

      // Extract content after upload (don't wait for completion)
      try {
        supabase.functions.invoke('extract-content', {
          body: {
            documentId: document.id,
            filePath: uploadData.path
          }
        });
      } catch (extractError) {
        console.error('Content extraction failed:', extractError);
        // Don't fail the upload if extraction fails
      }

      // Update status to complete
      setUploadingFiles(prev => 
        prev.map(f => f.id === id ? { ...f, status: 'complete' } : f)
      );

      toast({
        title: "Success",
        description: `${file.name} uploaded successfully`,
      });

      // Remove from uploading list after 2 seconds
      setTimeout(() => {
        setUploadingFiles(prev => prev.filter(f => f.id !== id));
      }, 2000);

      onUploadComplete?.();

    } catch (error) {
      console.error('Upload error:', error);
      setUploadingFiles(prev => 
        prev.map(f => f.id === uploadingFile.id ? { ...f, status: 'error' } : f)
      );
      
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "Failed to upload file",
        variant: "destructive",
      });
    }
  };

  const removeUploadingFile = (id: string) => {
    setUploadingFiles(prev => prev.filter(f => f.id !== id));
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/msword': ['.doc'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'text/plain': ['.txt'],
      'text/csv': ['.csv'],
    },
    maxSize: 10 * 1024 * 1024, // 10MB
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-6">
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragActive 
                ? 'border-primary bg-primary/10' 
                : 'border-muted-foreground/25 hover:border-primary/50'
            }`}
          >
            <input {...getInputProps()} />
            <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            {isDragActive ? (
              <p className="text-lg font-medium">Drop the files here...</p>
            ) : (
              <div className="space-y-2">
                <p className="text-lg font-medium">Drag & drop files here, or click to select</p>
                <p className="text-sm text-muted-foreground">
                  Supports PDF, DOC, DOCX, TXT, CSV files up to 10MB
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Uploading Files */}
      {uploadingFiles.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="font-medium mb-4">Uploading Files</h3>
            <div className="space-y-3">
              {uploadingFiles.map((uploadingFile) => (
                <div key={uploadingFile.id} className="flex items-center space-x-3">
                  <File className="h-5 w-5 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {uploadingFile.file.name}
                    </p>
                    {uploadingFile.status === 'uploading' && (
                      <Progress value={uploadingFile.progress} className="h-2 mt-1" />
                    )}
                  </div>
                  <div className="flex items-center space-x-2">
                    {uploadingFile.status === 'complete' && (
                      <CheckCircle className="h-5 w-5 text-green-500" />
                    )}
                    {uploadingFile.status === 'error' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeUploadingFile(uploadingFile.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default FileUpload;