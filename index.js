const express = require("express");
const qrcode = require("qrcode");
const socketIO = require("socket.io");
const http = require("http");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const cors = require('cors');

const { default: makeWASocket } = require("@whiskeysockets/baileys");
const {
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

// initial instance
const PORT = process.env.PORT || 8080;
const app = express();
const server = http.createServer(app);
const io = new socketIO.Server(server, {
  cors: {
    origin: "*",
  },
});

// index routing and middleware
app.use(cors({
  origin: '*',
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get("/", (_req, res) => {
  res.sendFile("index.html", { root: __dirname });
});

// socket connection
var today = new Date();
var now = today.toLocaleString();
let sock;
let phoneNumber = "";

function clearConnection() {
  if (fs.existsSync("./auth_info_baileys")) {
    phoneNumber = "";
    fs.rmSync(
      "./auth_info_baileys",
      { recursive: true, force: true },
      (err) => {
        if (err) console.log(err);
      }
    );
    io.emit("auth", phoneNumber);
  }
}

let isConnect = false;
async function connectToWhatsApp() {
  isConnect = true;
  // check or create credentials
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  sock = makeWASocket({
    // can provide additional config here
    printQRInTerminal: false,
    auth: state,
    qrTimeout: 20000
  });

  sock.ev.on("creds.update", (creds) => {
    saveCreds(creds);
    // io.emit('message', 'Creds Updated' + JSON.stringify(creds));
    if (creds?.me?.id) {
      io.emit("message", `${now} WhatsApp siap digunakan!`);
      phoneNumber = creds.me.id.split(":")[0];
      io.emit("auth", phoneNumber);
    }
  });

  sock.ev.on("connection.update", (update) => {
    console.log('----------------Client count--------------------', io.engine.clientsCount)

    const { connection, lastDisconnect, qr } = update;
    io.emit("log", update);
    if (qr && !phoneNumber) {
      qrcode.toDataURL(qr, (err, url) => {
        console.log("-------------SEND MESSAGE QR---------")
        io.emit("qr", url);
        io.emit("message", `${now} QR Code telah diterima`);
      });
    }
    if (connection === "close") {
      console.log("CLOSE");
      if (
        (lastDisconnect?.error instanceof Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut
      ) {
        switch (lastDisconnect.error?.output?.payload?.message) {
          case "QR refs attempts ended":
            sock.ws.close();
            io.emit(
              "message",
              "Request QR ended. reload scan to request QR again"
            );
            return;
          case "Connection Failure":
          case "Stream Errored (conflict)":
            console.log("connection failure");
            if (
              lastDisconnect.error?.output?.payload?.error == "Unauthorized"
            ) {
              io.emit(
                "message",
                "Koneksi WhatsApp terputus, menghubungkan ulang..."
              );
              clearConnection();
              connectToWhatsApp();
            }
            break;
          default:
            io.emit("message", "Restarting...");
            connectToWhatsApp();
            break;
        }
      } else {
        console.log("Connection closed. You are logged out.");
        io.emit("message", "Connection closed. You are logged out.");
      }
    } else if (connection === "open") {
      // io.emit("message", `${now} opened connection`);
      console.log("opened connection");
    }
  });
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];

    if (!m.message) return; // if there is no text or media message

    const messageText = m.message?.conversation ?? "";
    console.log("m.message", m.message);
    console.log("message.upsert", messageText);
  });
}
if (!isConnect) {
  connectToWhatsApp();
}


io.on("connection", (socket) => {
  socket.emit("message", `${now} Terhubung dengan sistem`);
  connectToWhatsApp();
});

const sendMessage = (message) => {
  if (io) {
    io.emit("message", now + " " + message);
  }
};

server.listen(PORT, () => {
  console.log("App listen on port ", PORT);
});

app.get("/check", async (req, res) => {
  if (phoneNumber) {
    res.status(200).json({
      error: false,
      data: {
        message: "Phone Number",
        meta: phoneNumber,
      },
    });
  } else {
    res.status(401).json({
      error: true,
      data: {
        message: "Error state",
        meta: "Unauthorize",
      },
    });
  }
});

app.post("/send", (req, res) => {
  const phone = req.body.phone + "@c.us";
  const message = req.body.message;

  // throw error when user not loggedin whatsapp
  if (!phoneNumber) {
    res.status(401).json({
      error: true,
      data: {
        message: "Error send message",
        meta: "Unauthorize",
      },
    });
    return;
  }

  sock
    .sendMessage(phone, { text: message })
    .then((response) => {
      sendMessage(`Pesan *${message}* berhasil terkirim ke +${req.body.phone}`);
      res.status(200).json({
        error: false,
        data: {
          message: "Pesan terkirim",
          meta: response,
        },
      });
    })
    .catch((error) => {
      sendMessage(`Pesan *${message}* gagal terkirim ke +${req.body.phone}`);
      res.status(400).json({
        error: true,
        data: {
          message: "Error send message",
          meta: error,
        },
      });
    });
});
