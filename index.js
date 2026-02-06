const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Google Drive setup
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

const drive = google.drive({ version: 'v3', auth });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SupaGEEK STL Upload API' });
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
    const prefix = `${dateStr}_${timeStr}_${(customerName || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_')}`;

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
          name: `${prefix}_${fileName}`,
          parents: [FOLDER_ID],
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
