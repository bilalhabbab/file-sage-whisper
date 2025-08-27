import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useState } from 'react';
import FileUpload from '@/components/FileUpload';
import DocumentsList from '@/components/DocumentsList';
import ChatInterface from '@/components/ChatInterface';

const Index = () => {
  const { user, signOut } = useAuth();
  const [documents, setDocuments] = useState([]);
  const [refreshDocuments, setRefreshDocuments] = useState(0);
  const [activeTab, setActiveTab] = useState<'upload' | 'chat'>('upload');

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">WSA Document Management</h1>
            <p className="text-muted-foreground">Welcome back, {user?.email}</p>
          </div>
          <Button onClick={signOut} variant="outline">
            Sign Out
          </Button>
        </header>

        {/* Navigation Tabs */}
        <div className="flex space-x-1 bg-muted p-1 rounded-lg mb-6">
          <Button
            variant={activeTab === 'upload' ? 'default' : 'ghost'}
            onClick={() => setActiveTab('upload')}
            className="flex-1"
          >
            File Management
          </Button>
          <Button
            variant={activeTab === 'chat' ? 'default' : 'ghost'}
            onClick={() => setActiveTab('chat')}
            className="flex-1"
          >
            AI Chat Assistant
          </Button>
        </div>

        {/* Tab Content */}
        {activeTab === 'upload' ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Upload Documents</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground mb-4">
                    Upload your organization documents for AI analysis.
                  </p>
                  <FileUpload onUploadComplete={() => setRefreshDocuments(prev => prev + 1)} />
                </CardContent>
              </Card>
            </div>
            <div>
              <DocumentsList 
                onDocumentsChange={setDocuments}
                refresh={refreshDocuments}
              />
            </div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto">
            <Card>
              <CardHeader>
                <CardTitle>AI Chat Assistant</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-4">
                  Ask questions about your uploaded documents using AI.
                </p>
                <ChatInterface documents={documents} />
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
};

export default Index;
