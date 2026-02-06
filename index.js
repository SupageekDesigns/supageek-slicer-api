const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3001;

// Handle preflight requests
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(200);
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Google OAuth setup
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI
);

if (OAUTH_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: OAUTH_REFRESH_TOKEN });
}

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SupaGEEK STL Upload API' });
});

// OAuth authorization routes
app.get('/auth', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/drive.file'];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    const { tokens } = await oauth2Client.getToken(code);
    res.send(`<h1>Authorization Successful!</h1><p>Refresh token (copy and save to Railway GOOGLE_OAUTH_REFRESH_TOKEN):</p><code>${tokens.refresh_token}</code>`);
  } catch (e) {
    res.status(500).send(`Auth failed: ${e.message}`);
  }
});

// Upload STL file to Google Drive
app.post('/upload', async (req, res) => {
  try {
    const { fileName, fileData, customerName, customerEmail } = req.body;

    if (!fileName || !fileData) {
      return res.status(400).json({ error: 'Missing fileName or fileData' });
    }

    const buffer = Buffer.from(fileData, 'base64');
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
    const folderName = `${dateStr}_${timeStr}_${customerName || 'Unknown'}`.replace(/[^a-zA-Z0-9_@.-]/g, '_');

    let customerFolderId = FOLDER_ID;
    try {
      const folderMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [FOLDER_ID],
      };
      const folder = await drive.files.create({
        resource: folderMetadata,
        fields: 'id',
      });
      customerFolderId = folder.data.id;
    } catch (folderErr) {
      console.error('Folder creation error:', folderErr);
    }

    const fileMetadata = {
      name: fileName,
      parents: [customerFolderId],
    };

    const media = {
      mimeType: 'application/octet-stream',
      body: stream,
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink',
    });

    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    const fileInfo = await drive.files.get({
      fileId: file.data.id,
      fields: 'webViewLink, webContentLink',
    });

    res.json({
      success: true,
      fileId: file.data.id,
      fileName: file.data.name,
      viewLink: fileInfo.data.webViewLink,
      downloadLink: fileInfo.data.webContentLink,
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// Batch upload multiple files
app.post('/upload-batch', async (req, res) => {
  try {
    const { files, customerName, customerEmail } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const results = [];

    // Create timestamp prefix for filenames
    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
    const folderName = `${dateStr}_${timeStr}_${(customerName || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_')}`;

    // Create folder for this batch
    let uploadFolderId = FOLDER_ID;
    try {
      const folderMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [FOLDER_ID],
      };
      const folder = await drive.files.create({
        resource: folderMetadata,
        fields: 'id',
      });
      uploadFolderId = folder.data.id;
      console.log(`Created folder: ${folderName} (${uploadFolderId})`);
    } catch (folderErr) {
      console.error('Folder creation error:', folderErr);
    }

    for (const fileObj of files) {

      try {
        const { fileName, fileData } = fileObj;
        if (!fileName || !fileData) continue;

        // Strip data URL prefix if present
        const base64Data = fileData.includes(',') ? fileData.split(',')[1] : fileData;
        const buffer = Buffer.from(base64Data, 'base64');
        console.log(`Processing ${fileName}: input length ${fileData.length}, buffer size ${buffer.length}`);
        
        const { Readable } = require('stream');
        const stream = Readable.from(buffer);

        // Upload directly to the shared folder with prefixed filename
      const fileMetadata = {
  name: fileName,
  parents: [uploadFolderId],
};
        const media = {
          mimeType: 'application/octet-stream',
          body: stream,
        };

        const file = await drive.files.create({
          resource: fileMetadata,
          media: media,
          fields: 'id, name, webViewLink',
        });

        console.log(`File created: ${file.data.id}`);

        await drive.permissions.create({
          fileId: file.data.id,
          requestBody: {
            role: 'reader',
            type: 'anyone',
          },
        });

        const fileInfo = await drive.files.get({
          fileId: file.data.id,
          fields: 'webViewLink, webContentLink',
        });

        results.push({
          success: true,
          fileName: file.data.name,
          viewLink: fileInfo.data.webViewLink,
          downloadLink: fileInfo.data.webContentLink,
        });

      } catch (fileErr) {
        console.error('File upload error:', fileErr.message);
        results.push({
          success: false,
          fileName: fileObj.fileName,
          error: fileErr.message,
        });
      }
    }

    res.json({
      success: true,
      folderLink: `https://drive.google.com/drive/folders/${FOLDER_ID}`,
      files: results,
    });

  } catch (error) {
    console.error('Batch upload error:', error);
    res.status(500).json({ error: error.message || 'Batch upload failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

