const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// REQUIRED ENV VARS
// ============================================================
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;
const OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

// Handle preflight requests
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(200);
});

// Middleware
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Google OAuth setup
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
  res.json({ status: 'ok', service: 'SupaGEEK STL Upload + Checkout API' });
});

// ============================================================
// MATERIALS ENDPOINT (FIXES QUOTE PAGE 404)
// ============================================================
app.get('/materials', (req, res) => {
  try {
    // Keep this list aligned with whatever your quote UI expects.
    // If the UI only needs strings, we can simplify later.
    const materials = [
      { id: 'PLA', name: 'PLA' },
      { id: 'PETG', name: 'PETG' },
      { id: 'ABS', name: 'ABS' },
      { id: 'ASA', name: 'ASA' },
      { id: 'TPU', name: 'TPU (Flexible)' },
      { id: 'Nylon', name: 'Nylon' },
      { id: 'CarbonFiber', name: 'Carbon Fiber' },
    ];

    res.json({ success: true, materials });
  } catch (error) {
    console.error('Error fetching materials:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// SQUARE CHECKOUT ENDPOINT
// ============================================================
app.post('/checkout', async (req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return res.status(500).json({
        error: 'Square is not configured (missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID)',
      });
    }

    const { items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    const idempotencyKey = require('crypto').randomUUID();

    const lineItems = items.map((item) => ({
      name: item.name,
      quantity: item.quantity.toString(),
      base_price_money: {
        amount: item.price, // already in cents
        currency: 'USD',
      },
    }));

    const requestBody = {
      idempotency_key: idempotencyKey,
      checkout_options: {
        allow_tipping: false,
        ask_for_shipping_address: true,
      },
    };

    if (items.length === 1 && items[0].quantity === 1) {
      requestBody.quick_pay = {
        name: items[0].name,
        price_money: {
          amount: items[0].price,
          currency: 'USD',
        },
        location_id: SQUARE_LOCATION_ID,
      };
    } else {
      requestBody.order = {
        location_id: SQUARE_LOCATION_ID,
        line_items: lineItems,
      };
    }

    const response = await fetch(
      'https://connect.squareup.com/v2/online-checkout/payment-links',
      {
        method: 'POST',
        headers: {
          'Square-Version': '2026-01-22',
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    const data = await response.json();

    if (data.payment_link) {
      return res.json({ checkoutUrl: data.payment_link.url });
    }

    const errorDetail =
      data.errors?.[0]?.detail ||
      data.errors?.[0]?.code ||
      'Failed to create checkout';
    const errorCategory = data.errors?.[0]?.category || 'UNKNOWN';

    console.error('Square error:', JSON.stringify(data.errors));
    return res.status(500).json({
      error: errorDetail,
      category: errorCategory,
      fullError: data.errors,
    });
  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
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
    res.send(
      `<h1>Authorization Successful!</h1><p>Refresh token (copy and save to Railway GOOGLE_OAUTH_REFRESH_TOKEN):</p><code>${tokens.refresh_token}</code>`
    );
  } catch (e) {
    res.status(500).send(`Auth failed: ${e.message}`);
  }
});

// Upload STL file to Google Drive
app.post('/upload', async (req, res) => {
  try {
    const { fileName, fileData, customerName, customerEmail } = req.body;

    if (!FOLDER_ID) {
      return res.status(500).json({ error: 'GOOGLE_DRIVE_FOLDER_ID not configured' });
    }
    if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !OAUTH_REDIRECT_URI) {
      return res.status(500).json({ error: 'Google OAuth not configured (missing client/secret/redirect)' });
    }
    if (!OAUTH_REFRESH_TOKEN) {
      return res.status(500).json({ error: 'Google OAuth not configured (missing refresh token)' });
    }

    if (!fileName || !fileData) {
      return res.status(400).json({ error: 'Missing fileName or fileData' });
    }

    const buffer = Buffer.from(fileData, 'base64');
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}`;
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
      requestBody: { role: 'reader', type: 'anyone' },
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

    if (!FOLDER_ID) {
      return res.status(500).json({ error: 'GOOGLE_DRIVE_FOLDER_ID not configured' });
    }
    if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET || !OAUTH_REDIRECT_URI) {
      return res.status(500).json({ error: 'Google OAuth not configured (missing client/secret/redirect)' });
    }
    if (!OAUTH_REFRESH_TOKEN) {
      return res.status(500).json({ error: 'Google OAuth not configured (missing refresh token)' });
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const results = [];

    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}`;
    const timeStr = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
    const folderName = `${dateStr}_${timeStr}_${(customerName || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_')}`;

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

        const base64Data = fileData.includes(',') ? fileData.split(',')[1] : fileData;
        const buffer = Buffer.from(base64Data, 'base64');
        console.log(`Processing ${fileName}: buffer size ${buffer.length}`);

        const { Readable } = require('stream');
        const stream = Readable.from(buffer);

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
          requestBody: { role: 'reader', type: 'anyone' },
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
      folderLink: `https://drive.google.com/drive/folders/${uploadFolderId}`,
      files: results,
    });
  } catch (error) {
    console.error('Batch upload error:', error);
    res.status(500).json({ error: error.message || 'Batch upload failed' });
  }
});

// Delete folder and all files (for payment failure cleanup)
app.delete('/cleanup/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;

    if (!folderId) {
      return res.status(400).json({ error: 'Missing folderId' });
    }

    await drive.files.delete({ fileId: folderId });

    res.json({ success: true, message: `Folder ${folderId} deleted` });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message || 'Cleanup failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
