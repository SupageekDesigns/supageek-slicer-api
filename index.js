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

    for (const fileObj of files) {
      try {
        const { fileName, fileData } = fileObj;
        if (!fileName || !fileData) continue;

        const buffer = Buffer.from(fileData, 'base64');
        const { Readable } = require('stream');
        const stream = new Readable();
        stream.push(buffer);
        stream.push(null);

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
          fields: 'id, name',
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

        results.push({
          success: true,
          fileName: file.data.name,
          viewLink: fileInfo.data.webViewLink,
        });

      } catch (fileErr) {
        console.error('File upload error:', fileErr);
        results.push({
          success: false,
          fileName: fileObj.fileName,
          error: fileErr.message,
        });
      }
    }

    const folderInfo = await drive.files.get({
      fileId: customerFolderId,
      fields: 'webViewLink',
    });

    res.json({
      success: true,
      folderLink: folderInfo.data.webViewLink,
      files: results,
    });

  } catch (error) {
    console.error('Batch upload error:', error);
    res.status(500).json({ error: error.message || 'Batch upload failed' });
  }
});

app.listen(PORT, () => {
  console.log(`SupaGEEK STL Upload API running on port ${PORT}`);
});
