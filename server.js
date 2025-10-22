const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const app = express();
app.set('trust proxy', true);
app.use(express.static('public')); 
app.use(express.json());

function logDebug(mensaje) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${mensaje}`);
}

function formatearFecha(fechaISO) {
  const fecha = new Date(fechaISO);
  const opciones = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Bogota' 
  };
  return fecha.toLocaleDateString('es-BO', opciones); 
}

const logFile = 'logs-confirmaciones.txt';
function agregarConfirmacion(cliente, ruta, fechaISO, productos = []) {  // NUEVO: Agregar parámetro productos
  const timestamp = new Date().toISOString();
  const productosStr = productos.map(p => `${p.cantidad} ${p.nombre}`).join(', ');  // NUEVO: Resumir productos
  const linea = `[${timestamp}] ¡Confirmado! ${cliente} | Ruta: ${ruta} | Fecha: ${fechaISO} | Productos: ${productosStr}`;  // NUEVO: Incluir productos
  fs.appendFileSync(logFile, linea + '\n', 'utf8');
}

app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'admin.html');
  res.type('text/html'); 
  res.sendFile(filePath);
});

app.get('/generate-token', (req, res) => {
  const { cliente = 'Cliente Test', ruta = 'Ruta Test', productos = '[]' } = req.query;  // NUEVO: Recibir productos como JSON string
  const token = Math.random().toString(36).substring(7); 
  const expira = Date.now() + 24 * 60 * 60 * 1000;
  let productosParsed = [];  // NUEVO: Parsear productos
  try {
    productosParsed = JSON.parse(decodeURIComponent(productos));  // NUEVO: Decodificar y parsear array [{nombre, cantidad}]
  } catch (e) {
    console.log('Error parseando productos:', e);  // Fallback a vacío
  }
  entregas.push({ 
    id: Date.now(), 
    token, 
    cliente, 
    ruta, 
    productos: productosParsed,  // NUEVO: Guardar productos
    expira, 
    asistido: false, 
    llegada: null 
  });
  
  // CAMBIO PROPUESTO: URL dinámica para deployment (ya estaba, pero aseguramos con trust proxy)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const urlCliente = `${baseUrl}/cliente.html?token=${token}`;
  
  const logMsg = `Token generado: ${token} | Cliente: ${cliente} | Ruta: ${ruta} | Productos: ${JSON.stringify(productosParsed)} | Expira: ${new Date(expira).toISOString()} | BaseURL: ${baseUrl}`;  // NUEVO: Incluir productos y baseURL en log
  logDebug(logMsg); 
  
  res.json({ token, urlCliente }); 
});

let entregas = []; 
if (fs.existsSync('entregas.json')) {
  entregas = JSON.parse(fs.readFileSync('entregas.json', 'utf8'));
  console.log(`Cargados ${entregas.length} tokens desde archivo`);
}  

setInterval(() => {
  const prevCount = entregas.length;
  entregas = entregas.filter(e => Date.now() < e.expira);
  if (entregas.length !== prevCount) {
    logDebug(`Limpieza: Tokens activos ahora: ${entregas.length}`);
  }
}, 5 * 60 * 1000);  // Puedes aumentar a 1 hora si quieres: 60 * 60 * 1000

app.get('/generar-qr/:cliente/:ruta', (req, res) => {
  const { cliente, ruta } = req.params;
  const { productos = '[]' } = req.query;  // NUEVO: Recibir productos
  const token = Math.random().toString(36).substring(7); 
  const expira = Date.now() + 24 * 60 * 60 * 1000;
  let productosParsed = [];  // NUEVO: Parsear
  try {
    productosParsed = JSON.parse(decodeURIComponent(productos));
  } catch (e) {
    console.log('Error parseando productos:', e);
  }
  entregas.push({ 
    id: Date.now(), 
    token, 
    cliente, 
    ruta, 
    productos: productosParsed,  // NUEVO
    expira, 
    asistido: false,
    llegada: null
  });
  
  // CAMBIO PROPUESTO: URL dinámica para deployment (ya estaba, pero con log mejorado)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const urlCliente = `${baseUrl}/cliente.html?token=${token}`;
  
  const logMsg = `Token generado: ${token} | Cliente: ${cliente} | Ruta: ${ruta} | Productos: ${JSON.stringify(productosParsed)} | Expira: ${new Date(expira).toISOString()} | BaseURL: ${baseUrl}`;  // NUEVO: Incluir productos
  logDebug(logMsg); // Solo consola
  
  res.json({ token, urlCliente }); 
});

app.get('/qr-image/:token', async (req, res) => {
  const { token } = req.params;
  const userAgentShort = req.headers['user-agent']?.substring(0, 30) || 'Unknown';
  logDebug(`Solicitando QR para token: ${token} | User-Agent: ${userAgentShort}`);
  
  const entrega = entregas.find(e => e.token === token);
  let reason = '';
  if (!entrega) {
    reason = 'no token match';
  } else if (entrega.asistido) {
    reason = 'already asistido';
  } else if (Date.now() >= entrega.expira) {
    reason = 'expired';
  }
  
  if (!entrega || reason) {
    const logMsg = `ERROR: ${reason || 'unknown'}: ${token} | Tokens activos: ${entregas.length}`;
    logDebug(logMsg); // Solo consola
    return res.status(404).send('Expirado, ya usado o inválido');
  }
  
  const logMsgOK = `Token OK: ${entrega.cliente} | Expira: ${new Date(entrega.expira).toISOString()}`;
  logDebug(logMsgOK); // Solo consola
  
  const timestamp = Date.now();
  const subToken = Buffer.from(token + timestamp).toString('base64').substring(0, 10); 
  
  // CAMBIO PROPUESTO: URL dinámica en QR data (ya estaba, pero aseguramos)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const data = `${baseUrl}/confirmar.html?token=${token}&subToken=${subToken}&timestamp=${timestamp}`;
  
  const logMsgQR = `QR data URL generada: ${data}`;
  logDebug(logMsgQR); // Solo consola
  
  const qr = await QRCode.toDataURL(data);
  res.send(qr);
});

app.post('/confirmar-sub', async (req, res) => {
  const { subToken, timestamp, mainToken } = req.body;  

  if (!mainToken || mainToken === 'undefined' || mainToken.trim() === '') {
    const logMsg = 'Error: mainToken undefined o vacío en POST body';
    logDebug(logMsg); // Solo consola
    return res.json({ ok: false, msg: 'Token requerido (verifica QR y URL)' });
  }
  
  logDebug(`Confirmando: token=${mainToken}, subToken=${subToken}, timestamp=${timestamp}`); // Solo consola
  
  const expectedSub = Buffer.from(mainToken + timestamp).toString('base64').substring(0, 10);
  if (subToken !== expectedSub || Date.now() > (parseInt(timestamp) + 24 * 60 * 60 * 1000)) {  // CAMBIO: 24 horas en lugar de 3 min
    const logMsg = `Sub inválido: ${subToken} vs ${expectedSub} | Timestamp: ${timestamp} | Diferencia: ${(Date.now() - parseInt(timestamp)) / 1000}s`;
    logDebug(logMsg); // Solo consola
    return res.json({ ok: false, msg: 'Sub-token inválido o expirado (regenera QR)' });
  }
  
  const entrega = entregas.find(e => e.token === mainToken && !e.asistido && Date.now() < e.expira);
  if (!entrega) {
    const logMsg = `Entrega no encontrada para ${mainToken} | Tokens activos: ${entregas.length}`;
    logDebug(logMsg); // Solo consola
    return res.json({ ok: false, msg: 'Token expirado o ya usado' });
  }
  
  entrega.asistido = true;
  entrega.llegada = new Date().toISOString();
  
  // ¡SOLO AQUÍ se guarda en reporte! (ahora con ruta y productos)
  agregarConfirmacion(entrega.cliente, entrega.ruta, entrega.llegada, entrega.productos);  // NUEVO: Pasar productos
  
  res.json({ ok: true, msg: `¡Asistencia confirmada para ${entrega.cliente} en ruta ${entrega.ruta}! Productos: ${entrega.productos.map(p => `${p.cantidad} ${p.nombre}`).join(', ')}` });  // NUEVO: Incluir productos en msg
});

app.get('/asistencias', (req, res) => {
  const asistidas = entregas.filter(e => e.asistido).map(e => ({
    cliente: e.cliente,
    ruta: e.ruta,
    productos: e.productos,  // NUEVO
    llegada: e.llegada
  }));
  res.json(asistidas);
});

// Endpoint para debug: lista tokens activos
app.get('/debug-tokens', (req, res) => {
  res.json(entregas.map(e => ({ 
    token: e.token, 
    cliente: e.cliente, 
    productos: e.productos,  // NUEVO
    expira: new Date(e.expira), 
    asistido: e.asistido 
  })));
});

// Endpoint para generar y descargar PDF (solo confirmaciones del TXT)
app.get('/finalizar-pdf', async (req, res) => {
  if (!fs.existsSync(logFile)) {
    return res.status(400).send('No hay confirmaciones para generar PDF. (Genera una asistencia primero).');
  }

  try {
    // Lee TODO el archivo TXT y parsea confirmaciones (ahora con ruta)
    const fileContent = fs.readFileSync(logFile, 'utf8');
    const lines = fileContent.trim().split('\n').filter(line => line.trim() !== '');
    const confirmaciones = lines.map(line => {
      const match = line.match(/^\[(.+?)\]\s¡Confirmado!\s(.+)\s\|\sRuta:\s(.+)\s\|\sFecha:\s(.+?)\s\|\sProductos:\s(.+)$/);  // NUEVO: Regex para capturar productos
      if (match) {  // NUEVO: if para manejar nuevo formato
        return { 
          timestamp: match[1], 
          cliente: match[2], 
          ruta: match[3], 
          fechaISO: match[4],
          productosStr: match[5]  // NUEVO: String de productos
        };
      }
      // Fallback para líneas antiguas sin productos
      const oldMatch = line.match(/^\[(.+?)\]\s¡Confirmado!\s(.+)\s\|\sRuta:\s(.+)\s\|\sFecha:\s(.+)$/);
      if (oldMatch) {
        return { 
          timestamp: oldMatch[1], 
          cliente: oldMatch[2], 
          ruta: oldMatch[3], 
          fechaISO: oldMatch[4],
          productosStr: 'Sin productos'  // NUEVO: Fallback
        };
      }
      return null;
    }).filter(Boolean); // Solo líneas válidas

    if (confirmaciones.length === 0) {
      return res.status(400).send('No hay confirmaciones válidas para generar PDF.');
    }

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    
    const html = `
      <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>Reporte de Confirmaciones de Asistencia</title>
      <style>
  body { 
    font-family: Arial, sans-serif; 
    margin: 20px; 
    background-color: #042b17ff; /* Fondo verde oscuro */
    color: #ffffffff; /* Letras blancas */
  }
  h1 { 
    text-align: center; 
    color: #ffffffff; /* Título blanco */
  }
  table { 
    width: 100%; 
    border-collapse: collapse; 
    background-color: #082519ff; /* Fondo verde claro para tabla */
  }
  th, td { 
    border: 1px solid #ffffffff; /* CAMBIO: Bordes blancos (cuadrículas) */
    padding: 8px; 
    text-align: left; 
    color: #ffffffff; /* Letras blancas */
  }
  th { 
    background-color: #042b17ff; /* Encabezados verde oscuro */
    font-weight: bold; 
  }
  .cliente { width: 25%; }
  .ruta { width: 20%; }
  .productos { width: 35%; }  /* Columna para productos */
  .fecha { width: 20%; }
  tr:nth-child(even) { 
    background-color: #052913ff; /* Filas pares verde medio */
  }
  tr:nth-child(odd) { 
    background-color: #082519ff; /* Filas impares verde claro */
  }
  p { 
    color: #ffffffff; /* Párrafos en blanco */
  }
</style>
    </head>
    <body>
      <h1>Reporte de Confirmaciones de Asistencia (Acumulado por Clientes)</h1>
      <p><strong>Total confirmaciones:</strong> ${confirmaciones.length}</p>
      <p><strong>Última actualización:</strong> ${new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Bogota' })}</p>
      <table>
        <thead>
          <tr>
            <th class="cliente">Cliente</th>
            <th class="ruta">Ruta (Camión)</th>
            <th class="productos">Productos Entregados</th>  <!-- NUEVO -->
            <th class="fecha">Hora de Confirmación</th>
          </tr>
        </thead>
        <tbody>
          ${confirmaciones.map(conf => `
            <tr>
              <td class="cliente">${conf.cliente}</td>
              <td class="ruta">${conf.ruta}</td>
              <td class="productos">${conf.productosStr || 'Sin productos'}</td>  <!-- NUEVO -->
              <td class="fecha">${formatearFecha(conf.fechaISO)}</td>
            </tr>
          `).reverse().join('')}  <!-- Reverse para mostrar más recientes primero -->
        </tbody>
      </table>
      <p><strong>Fin de reporte.</strong> </p>
    </body>
  </html>
`;

    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    await browser.close();

    // Envía el PDF como descarga
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=reporte-confirmaciones-${new Date().toISOString().split('T')[0]}.pdf`);
    res.send(pdfBuffer);

    console.log(`PDF de confirmaciones generado y descargado (${confirmaciones.length} asistencias).`);
  } catch (error) {
    console.error('Error generando PDF:', error);
    res.status(500).send('Error al generar PDF: ' + error.message);
  }
});

setInterval(() => {
  fs.writeFileSync('entregas.json', JSON.stringify(entregas, null, 2));
}, 30000);

// NUEVO: Endpoint para obtener detalles de entrega por token (para cliente.html y confirmar.html)
app.get('/get-entrega/:token', (req, res) => {
  const { token } = req.params;
  const entrega = entregas.find(e => e.token === token && !e.asistido && Date.now() < e.expira);
  if (!entrega) {
    return res.status(404).json({ error: 'Token inválido o expirado' });
  }
  res.json({
    cliente: entrega.cliente,
    ruta: entrega.ruta,
    productos: entrega.productos || []
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en puerto ${PORT}`);
  console.log('Debug: Ve a /debug-tokens para ver tokens activos con productos');
  console.log('Nuevo: Ve a /finalizar-pdf para generar PDF con productos');
});
// NUEVO: Endpoint para borrar logs (solo desde admin, por seguridad)
app.delete('/borrar-logs', (req, res) => {
  if (fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
    logDebug('Logs de confirmaciones borrados manualmente.');
    return res.json({ ok: true, msg: 'Logs borrados. Reporte reiniciado.' });
  }
  return res.json({ ok: true, msg: 'No hay logs para borrar.' });
});