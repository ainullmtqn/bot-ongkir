import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import cron from 'node-cron';
import dotenv from 'dotenv';
import pino from 'pino';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

// Penanganan Multi-Token (Rotasi Otomatis)
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
let currentKeyIndex = 0;

if (apiKeys.length === 0) {
  console.error('❌ Tidak ditemukan GEMINI_API_KEY atau GEMINI_API_KEYS di file .env!');
} else {
  console.log(`🔑 Berhasil memuat ${apiKeys.length} API Key Gemini untuk rotasi otomatis.`);
}

function getAIClient() {
  return new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
}

const ADMIN_PHONE = (process.env.ADMIN_PHONE_NUMBER || '').replace(/\D/g, '');
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;
const MODEL_NAME = 'gemini-3.8-flash';

function getTanggalWIB() {
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
}

// Helper: Pembersih teks JSON agar tahan terhadap format Markdown dari AI
function cleanJsonText(raw) {
  if (!raw) return '{}';
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

// PROMPT MANIFES: Dilengkapi pemetaan wilayah Kalmas (DDC = Dandoangan Caddi, DDL = Dandoangan Lompo) dan Puma
const SYSTEM_PROMPT_MANIFES = `Anda adalah sistem AI parser, auditor, dan penormalisasi data logistik muatan kapal ikan/ongkir laut.
Tugas Anda mengekstrak pesan grup WhatsApp berisi daftar manifes muatan kapal ke format JSON terstruktur murni dan melakukan audit hitungan fisik muatan.

ATURAN PARSING & EKSTRAKSI:
1. Jika bukan laporan manifes atau info operasional pelayaran, keluarkan: {"status": "abaikan"}
2. Tipe Pesan:
   - "BARU" : Laporan manifes kapal baru.
   - "REVISI_PENUH" / "TAMBAHAN_PARSIAL" : Perubahan atau penambahan muatan.
   - "BATAL_PELAYARAN" : Kapal dinyatakan batal berangkat/cancel.
3. Normalisasi Header Pelayaran & Wilayah/Dermaga:
   - PEMETAAN LOKASI:
     * "Puma" dan "Kalmas" adalah nama wilayah/tempat utama.
     * "DDC" adalah singkatan dari Dandoangan Caddi (sering salah ketik DCC).
     * "DDL" adalah singkatan dari Dandoangan Lompo.
     * Keduanya (DDC dan DDL) merupakan bagian dermaga dari wilayah Kalmas.
     * Standarisasi lokasi_muat:
       - Jika tertulis "DDC.DDL", "DDC DDL", atau "DDC/DDL" -> "Kalmas - DDC & DDL"
       - Jika hanya "DDC" atau "DCC" -> "Kalmas - DDC"
       - Jika hanya "DDL" -> "Kalmas - DDL"
       - Jika tertulis "Puma" -> "Puma"
       - Jika tertulis "Kalmas" tanpa dermaga -> "Kalmas"
   - Kunci Unik: NAMA-KAPAL_YYYY-MM-DD_LOKASI (Huruf kapital, spasi diganti garis bawah, hapus titik, contoh: "KMN_CAHAYA_NUR_AISYAH_2026-10-17_KALMAS_DDC_DDL", "KMN_AMALIA_2026-10-13_KALMAS_DDC", "KMN_FAIZJAYA_2026-10-15_PUMA").
   - Nama Kapal & Layanan: Jika digabung dalam satu baris (contoh: "Kapal Ongkir KMN FAIZJAYA"), pisahkan jenis_layanan menjadi "Kapal Ongkir" dan nama_kapal menjadi "KMN FAIZJAYA".
   - Juragan: Hilangkan awalan "Jrg", "Juragan", atau "Jrg." (contoh: "Jrg Dg Limpo" -> "Dg Limpo", "Jrg Pak Maman" -> "Pak Maman", "Jrg Bang Daharil" -> "Bang Daharil").
   - Tanggal: Format ISO YYYY-MM-DD. Teks tanggal lokal seperti "Sabtu 17 -Oktober-2026", "Selasa.13 -Oktober-2026", "Kamis ,15-10-2026" WAJIB diubah ke "YYYY-MM-DD".
   - Waktu Berangkat (Jam): Format "HH:mm". Ubah variasi seperti "14.00", "14 00", "10:00" menjadi "14:00", "10:00".
4. Normalisasi Simbol & Pemilik Muatan:
   - EMOJI BINTANG (⭐, ⭐️): WAJIB diubah menjadi kata "Bintang".
   - EMOJI BULAN (🌙, 🌕, 🌑, 🌛): WAJIB diubah menjadi kata "Bulan".
   - KOMBINASI EMOJI: Jika ada emoji ganda/bertumpuk (contoh: "Alam 🌙⭐", "Asrul🌙⭐"), ubah berurutan menjadi "Bulan Bintang" (contoh: "Alam Bulan Bintang", "Asrul Bulan Bintang").
   - Emoji di depan nama (contoh: "⭐55 DTP" -> "Bintang 55 DTP", "⭐️ Kejora" -> "Bintang Kejora").
   - Emoji di belakang nama (contoh: "Cahaya ⭐" -> "Cahaya Bintang").
5. Ekstraksi Rincian Muatan:
   - ABAIKAN NOMOR URUT: Jangan bergantung pada urutan nomor karena nomor urut di chat sering acak, kembar, atau melompat. Ambil setiap baris muatan sebagai 1 entitas.
   - PENGAMBILAN ANGKA: Ambil angka kuantitas murni di sekitar tanda '=', terlepas ada spasi atau tidak (contoh: "= 12 G", "=15 G", "=26 G", "= 11G").
   - SATUAN: Selalu gunakan kata baku "Gabus".
6. Audit Hitungan:
   - Hitung total kuantitas dari seluruh array rincian_muatan.
   - Cocokkan dengan total muatan tertulis di teks.
   - Jika cocok: apakah_cocok: true, selisih: 0. Jika selisih: apakah_cocok: false, selisih: (tertulis - terhitung).
7. Reaksi Emoji Status:
   - "CENTANG" (✅) : Status BARU/REVISI dan total muatan COCOK.
   - "PERINGATAN" (⚠️) : Terdapat selisih hitung ATAU kapal batal berangkat.
8. Keluarkan HANYA format JSON valid murni tanpa markdown.

SKEMA JSON:
{
  "status": "sukses",
  "tipe_pesan": "BARU | REVISI_PENUH | TAMBAHAN_PARSIAL | BATAL_PELAYARAN",
  "emoji_reaksi": "CENTANG | UPDATE | PERINGATAN",
  "kunci_unik": "STRING",
  "data_pelayaran": {
    "jenis_layanan": "string atau null",
    "nama_kapal": "string",
    "juragan": "string",
    "tanggal": "YYYY-MM-DD",
    "lokasi_muat": "string",
    "waktu_berangkat": "string",
    "total_muatan_tertulis": 0
  },
  "rincian_muatan": [
    { "nama_pemilik": "string", "jumlah": 0, "satuan": "Gabus" }
  ],
  "audit": {
    "total_muatan_terhitung": 0,
    "selisih": 0,
    "apakah_cocok": true,
    "catatan_anomali": null
  },
  "keterangan_operasional": null
}`;

// PROMPT ROUTER JAPRI ADMIN
const SYSTEM_PROMPT_ROUTER = `Anda adalah asisten router database logistik muatan kapal.
Tugas Anda membaca pesan japri admin dan mengekstrak parameter aksi.
Keluarkan JSON valid murni:
{
  "aksi": "CEK_KAPAL | LACAK_AGEN | REKAP_HARIAN | RESET_DATA",
  "nama_kapal": "string atau null",
  "nama_pemilik": "string atau null",
  "tanggal": "YYYY-MM-DD | HARI_INI"
}`;

async function generateContentWithRetry(params, maxRetries = Math.max(apiKeys.length * 2, 4), delayMs = 2500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const ai = getAIClient();
      return await ai.models.generateContent(params);
    } catch (err) {
      const errStr = JSON.stringify(err) + ' ' + (err.message || '');
      const is429 = errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota');
      const is503 = errStr.includes('503') || errStr.includes('UNAVAILABLE');

      if (is429 && apiKeys.length > 1) {
        currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        console.log(`🔄 Token ke-${currentKeyIndex === 0 ? apiKeys.length : currentKeyIndex} habis. Beralih ke token ke-${currentKeyIndex + 1}...`);
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }

      if (is503 && attempt < maxRetries) {
        const waitTime = delayMs * attempt;
        console.log(`⚠️ Server AI sibuk (503). Menunggu ${waitTime / 1000}s (Percobaan ${attempt}/${maxRetries})...`);
        await new Promise((res) => setTimeout(res, waitTime));
        continue;
      }

      throw err;
    }
  }
}

// Fungsi Pemroses Pesan Manifes Grup dengan Retry & Alert Anti-Gagal
async function processManifestMessageWithRetry(sock, msg, from, text, maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`🔄 [Mencoba Ulang ${attempt}/${maxAttempts}] Memproses ulang pesan manifes...`);
      }

      const response = await generateContentWithRetry({
        model: MODEL_NAME,
        contents: text,
        config: {
          systemInstruction: SYSTEM_PROMPT_MANIFES,
          responseMimeType: 'application/json'
        }
      });

      const parsed = JSON.parse(cleanJsonText(response.text));

      // Jika AI menilai bukan laporan manifes
      if (parsed.status === 'abaikan') {
        return;
      }

      if (parsed.status === 'sukses') {
        // 1. Reaksi Emoji di Pesan Grup
        const emojiMap = { CENTANG: '✅', UPDATE: '🔄', PERINGATAN: '⚠️' };
        await sock.sendMessage(from, {
          react: { text: emojiMap[parsed.emoji_reaksi] || '✅', key: msg.key }
        });

        // 2. Simpan Data ke Webhook Google Sheets
        await axios.post(process.env.GAS_WEBHOOK_URL, parsed, { timeout: 15000 });

        // 3. Notifikasi Japri Admin jika Ada Selisih Hitung
        if (!parsed.audit.apakah_cocok && parsed.tipe_pesan !== 'BATAL_PELAYARAN') {
          const pesanPeringatan = `⚠️ *PERINGATAN SELISIH HITUNG GABUS*\n` +
            `🚢 Kapal: *${parsed.data_pelayaran.nama_kapal}*\n` +
            `📅 Tanggal: ${parsed.data_pelayaran.tanggal}\n` +
            `📝 Tertulis: ${parsed.data_pelayaran.total_muatan_tertulis} Gabus\n` +
            `🔢 Terhitung: ${parsed.audit.total_muatan_terhitung} Gabus\n` +
            `❗ Selisih: ${parsed.audit.selisih} Gabus\n` +
            `📌 Catatan: ${parsed.audit.catatan_anomali}`;
          await sock.sendMessage(ADMIN_JID, { text: pesanPeringatan });
        }

        // 4. Alert Japri Admin jika Kapal Batal atau Ada Ralat
        if (parsed.tipe_pesan === 'BATAL_PELAYARAN') {
          const pesanBatal = `🛑 *PERINGATAN PEMBATALAN PELAYARAN*\n` +
            `🚢 Kapal: *${parsed.data_pelayaran.nama_kapal}*\n` +
            `📅 Tanggal: ${parsed.data_pelayaran.tanggal}\n` +
            `ℹ️ Status: Pelayaran dibatalkan dan dihapus dari rekaman.`;
          await sock.sendMessage(ADMIN_JID, { text: pesanBatal });
        } else if (parsed.keterangan_operasional) {
          const pesanAlert = `📢 *PERUBAHAN OPERASIONAL LAPANGAN*\n` +
            `🚢 Kapal: *${parsed.data_pelayaran.nama_kapal}*\n` +
            `ℹ️ Ralat: ${parsed.keterangan_operasional}`;
          await sock.sendMessage(ADMIN_JID, { text: pesanAlert });
        }

        console.log(`✅ Pesan manifes berhasil diproses pada percobaan ke-${attempt}.`);
        return;
      }
    } catch (err) {
      lastError = err;
      console.error(`⚠️ Percobaan ${attempt}/${maxAttempts} gagal: ${err.message}`);
      if (attempt < maxAttempts) {
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
  }

  // JIKA SELURUH PERCOBAAN GAGAL: Beri reaksi silang merah dan kirim notifikasi darurat ke admin
  console.error(`❌ Pesan manifes gagal diproses setelah ${maxAttempts} kali percobaan:`, lastError?.message);

  try {
    await sock.sendMessage(from, {
      react: { text: '❌', key: msg.key }
    });

    const cuplikanPesan = text.length > 250 ? text.substring(0, 250) + '...' : text;
    const pesanGagalAdmin = `🚨 *MANIFES GAGAL TERCATAT OTOMATIS* 🚨\n` +
      `Sistem telah mencoba 3x namun terjadi kendala saat parsing / simpan ke Sheets.\n\n` +
      `📝 *Isi Pesan:*\n"${cuplikanPesan}"\n\n` +
      `❗ *Kendala:* ${lastError?.message || 'Format tidak terbaca'}\n` +
      `ℹ️ _Mohon periksa kembali pesan tersebut atau input manual jika diperlukan._`;

    await sock.sendMessage(ADMIN_JID, { text: pesanGagalAdmin });
  } catch (notifyErr) {
    console.error('Gagal mengirimkan notifikasi kegagalan ke admin:', notifyErr.message);
  }
}

let activeSock = null;

async function handleResetSession(sock, targetJid) {
  try {
    await sock.sendMessage(targetJid, {
      text: '🔄 *MERESET SESI WHATSAPP...*\nKredensial lama dihapus. Silakan scan QR Code baru di terminal.'
    });

    try { await sock.logout(); } catch (e) {}

    if (fs.existsSync('auth_session')) {
      fs.rmSync('auth_session', { recursive: true, force: true });
      console.log('🗑️ auth_session dibersihkan.');
    }

    startBot();
  } catch (err) {
    console.error('Gagal reset sesi:', err);
    await sock.sendMessage(targetJid, { text: '❌ Kendala saat mereset sesi WA.' });
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  activeSock = sock;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 Pindai QR Code di bawah menggunakan WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const reconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Menghubungkan ulang...', reconnect);
      if (reconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp Manifes Kapal Berhasil Terhubung!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Penanganan Pesan Masuk (Looping Semua Pesan dalam Antrean)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

      if (!text) continue;

      console.log(`📩 Pesan masuk dari ${from}: ${text.substring(0, 70)}...`);

      const cleanText = text.trim().toLowerCase();

      // FITUR: MENU RINGKAS
      if (cleanText === 'menu' || cleanText === 'help' || cleanText === 'bantuan' || cleanText === 'panduan') {
        const menuRingkas = `📋 *MENU BOT OPERASIONAL KAPAL* 🚢\n\n` +
          `*1. Pencatatan Otomatis (Grup)*\n` +
          `• Catat manifes & audit muatan gabus\n` +
          `• Normalisasi simbol (⭐️ ➔ Bintang, 🌙 ➔ Bulan)\n` +
          `• Normalisasi lokasi: Kalmas (DDC/DDL) & Puma\n` +
          `• Reaksi status: ✅ Cocok | 🔄 Revisi | ⚠️ Selisih | ❌ Gagal\n\n` +
          `*2. Pengecekan Data (Japri)*\n` +
          `• *rekap hari ini* atau *rekap [YYYY-MM-DD]*\n` +
          `• *cek [nama kapal]*\n` +
          `• *lacak [nama pedagang/agen]*\n\n` +
          `*3. Pengaturan & Database*\n` +
          `• *reset data* (bersihkan data hari ini)\n` +
          `• *reset data [YYYY-MM-DD]*\n` +
          `• *reset sesi* (scan ulang QR WhatsApp)\n` +
          `• *menu* (tampilkan ringkasan ini)\n\n` +
          `*4. Laporan Otomatis*\n` +
          `• Rekap penutupan dikirim setiap 23:59 WIB ke Admin.`;

        await sock.sendMessage(from, { text: menuRingkas }, { quoted: msg });
        continue;
      }

      // FITUR: PERINTAH CEPAT RESET / HAPUS DATA
      if (cleanText.startsWith('reset data') || cleanText.startsWith('hapus data')) {
        try {
          const parts = text.trim().split(/\s+/);
          let tanggalTarget = getTanggalWIB();
          if (parts.length > 2 && /\d{4}-\d{2}-\d{2}/.test(parts[2])) {
            tanggalTarget = parts[2];
          }

          console.log(`🧹 Reset data tanggal: ${tanggalTarget}...`);

          await axios.post(process.env.GAS_WEBHOOK_URL, {
            aksi: 'RESET_DATA',
            tanggal: tanggalTarget
          });

          await sock.sendMessage(from, {
            text: `✅ *DATA BERHASIL DIBERSIHKAN*\n\nSeluruh data manifes kapal dan muatan untuk tanggal *${tanggalTarget}* telah dihapus dari Google Sheets.`
          }, { quoted: msg });

          continue;
        } catch (err) {
          console.error('Gagal reset data:', err.message);
          await sock.sendMessage(from, { text: `❌ Gagal menghapus data: ${err.message}` }, { quoted: msg });
          continue;
        }
      }

      // FITUR: RESET SESI LOGIN WA
      if (cleanText === 'reset sesi' || cleanText === 'logout' || cleanText === 'reset wa') {
        await handleResetSession(sock, from);
        continue;
      }

      // ALUR 1: PESAN GRUP (Ekstraksi Manifes Kapal dengan Retry 3x)
      if (isGroup) {
        const kataKunciManifes = /kmn|km\b|kapal|muatan|gabus|\bg\b|jrg|juragan|ongkir|bintang|bulan|⭐️|⭐|🌙|🌕|ddc|ddl|dcc|kalmas|puma|dandoangan|caddi|lompo/i;
        if (!kataKunciManifes.test(text)) {
          continue;
        }

        await processManifestMessageWithRetry(sock, msg, from, text, 3);
      }

      // ALUR 2: JAPRI ADMIN (Pengecekan Manifes & Lacak Muatan)
      if (!isGroup) {
        await processAdminChat(sock, from, text);
      }
    }
  });

  // ALUR 3: LAPORAN PENUTUPAN AKHIR MALAM (23:59 WIB)
  cron.schedule('59 23 * * *', async () => {
    try {
      const today = getTanggalWIB();
      const res = await axios.get(`${process.env.GAS_WEBHOOK_URL}?tanggal=${today}`);
      const pelayaran = res.data.pelayaran || [];

      if (pelayaran.length === 0) return;

      let totalGabus = 0;
      let rincianTeks = '';

      pelayaran.forEach((p, idx) => {
        totalGabus += Number(p.total_hitung || 0);
        const icon = p.status_selisih === 'SESUAI' ? '✅' : '⚠️';
        rincianTeks += `${idx + 1}. *${p.nama_kapal}* (${p.lokasi_muat} | ${p.jam_berangkat})\n` +
          `   └ Muatan: *${p.total_hitung} Gabus* [${icon}]\n`;
      });

      const laporanAkhir = `📋 *REKAP AKHIR OPERASIONAL HARIAN*\n` +
        `📅 Tanggal: ${today}\n` +
        `⏰ Waktu Cetak: 23:59\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `🚢 *Total Kapal:* ${pelayaran.length} Kapal\n` +
        `📦 *Total Muatan:* ${totalGabus} Gabus\n\n` +
        `*Daftar Kapal:*\n${rincianTeks}` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `_Laporan harian otomatis ditutup dan tersimpan di database._`;

      await sock.sendMessage(ADMIN_JID, { text: laporanAkhir });
    } catch (e) {
      console.error('Gagal mengirim rekap 23:59:', e.message);
    }
  }, {
    timezone: 'Asia/Jakarta'
  });
}

async function processAdminChat(sock, replyJid, userText) {
  try {
    const today = getTanggalWIB();

    const routerRes = await generateContentWithRetry({
      model: MODEL_NAME,
      contents: userText,
      config: {
        systemInstruction: SYSTEM_PROMPT_ROUTER,
        responseMimeType: 'application/json'
      }
    });

    const queryParams = JSON.parse(cleanJsonText(routerRes.text));
    const tanggalTarget = queryParams.tanggal === 'HARI_INI' ? today : (queryParams.tanggal || today);

    if (queryParams.aksi === 'REKAP_HARIAN') {
      const res = await axios.get(`${process.env.GAS_WEBHOOK_URL}?tanggal=${tanggalTarget}`);
      const list = res.data.pelayaran || [];
      if (list.length === 0) {
        await sock.sendMessage(replyJid, { text: `Belum ada data pelayaran untuk tanggal ${tanggalTarget}.` });
        return;
      }
      let teks = `📊 *REKAP PENGIRIMAN (${tanggalTarget})*\n━━━━━━━━━━━━━━━━━━━\n`;
      list.forEach((k) => {
        teks += `🚢 *${k.nama_kapal}* (${k.lokasi_muat} - ${k.jam_berangkat})\n` +
          `   └ Total: *${k.total_hitung} Gabus* [${k.status_selisih}]\n`;
      });
      await sock.sendMessage(replyJid, { text: teks });

    } else if (queryParams.aksi === 'LACAK_AGEN') {
      const agen = queryParams.nama_pemilik || userText.replace(/cek|lacak/gi, '').trim();
      const res = await axios.get(`${process.env.GAS_WEBHOOK_URL}?tanggal=${tanggalTarget}&agen=${encodeURIComponent(agen)}`);
      const rincian = res.data.rincian || [];
      if (rincian.length === 0) {
        await sock.sendMessage(replyJid, { text: `Tidak ditemukan muatan untuk "${agen}" pada tanggal ${tanggalTarget}.` });
        return;
      }
      let total = 0;
      let teks = `📦 *PELACAKAN MUATAN: ${agen.toUpperCase()}*\n📅 Tanggal: ${tanggalTarget}\n━━━━━━━━━━━━━━━━━━━\n`;
      rincian.forEach((item) => {
        total += Number(item.jumlah);
        teks += `• *${item.nama_kapal}*: ${item.jumlah} Gabus\n`;
      });
      teks += `━━━━━━━━━━━━━━━━━━━\n📊 *Total Muatan:* ${total} Gabus`;
      await sock.sendMessage(replyJid, { text: teks });

    } else if (queryParams.aksi === 'CEK_KAPAL') {
      const kapal = queryParams.nama_kapal || userText.replace(/cek/gi, '').trim();
      const res = await axios.get(`${process.env.GAS_WEBHOOK_URL}?tanggal=${tanggalTarget}&kapal=${encodeURIComponent(kapal)}`);
      const list = res.data.pelayaran || [];
      if (list.length === 0) {
        await sock.sendMessage(replyJid, { text: `Tidak ditemukan data kapal "${kapal}" pada tanggal ${tanggalTarget}.` });
        return;
      }
      const k = list[0];
      const balasan = `🚢 *DETAIL MANIFES KAPAL*\n━━━━━━━━━━━━━━━━━━━\n` +
        `Nama Kapal: *${k.nama_kapal}*\n` +
        `Juragan: ${k.juragan}\n` +
        `Muat di: ${k.lokasi_muat} (${k.jam_berangkat})\n` +
        `Total Muatan: *${k.total_hitung} Gabus*\n` +
        `Status Audit: *${k.status_selisih}*`;
      await sock.sendMessage(replyJid, { text: balasan });
    }
  } catch (err) {
    console.error('Gagal menangani japri admin:', err.message);
    await sock.sendMessage(replyJid, { text: 'Terjadi kendala saat membaca data spreadsheet.' });
  }
}

startBot();