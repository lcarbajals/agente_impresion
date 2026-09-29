const axios = require('axios');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ============================================
// CARGAR CONFIGURACIÓN
// ============================================
const configPath = path.join(__dirname, 'config.json');
let config;

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
    console.error('❌ Error al leer config.json:', error.message);
    console.error('   Asegúrate de que el archivo exista y sea JSON válido.');
    process.exit(1);
}

// ============================================
// CLIENTE HTTP (Axios configurado)
// ============================================
const api = axios.create({
    baseURL: config.url_api,
    headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    },
    timeout: 15000
});

// ============================================
// FUNCIONES AUXILIARES
// ============================================

function registrarErrorEnArchivo(mensaje, errorDetalle = '') {
    const fecha = new Date().toLocaleString('es-PE');
	
    const linea = `[${fecha}] ERROR: ${mensaje} | Detalle: ${errorDetalle}\n`;
    const rutaLog = path.join(__dirname, 'errores.log');

    // fs.appendFile crea el archivo si no existe y agrega al final si ya existe
    fs.appendFile(rutaLog, linea, (err) => {
        if (err) {
            console.error('⚠️ No se pudo escribir en el archivo de log:', err.message);
        }
    });
}

/**
 * Log con timestamp
 */
function log(mensaje, tipo = 'INFO') {
    const timestamp = new Date().toLocaleString('es-PE');
    const colores = {
        'INFO': '\x1b[36m',   // Cyan
        'OK': '\x1b[32m',     // Verde
        'ERROR': '\x1b[31m',  // Rojo
        'WARN': '\x1b[33m'    // Amarillo
    };
    const reset = '\x1b[0m';
    const color = colores[tipo] || '';
    console.log(`${color}[${timestamp}] [${tipo}]${reset} ${mensaje}`);
}

/**
 * Envía bytes a la impresora por socket TCP
 */
/**
 * Envía bytes a la impresora por socket TCP
 */
function enviarAImpresora(ip, puerto, bytes) {
    return new Promise((resolve, reject) => {
        // Log de depuración para estar 100% seguros de los valores
        console.log(`[DEBUG] Conectando a IP: "${ip}" (tipo: ${typeof ip}), Puerto: ${puerto} (tipo: ${typeof puerto})`);
        
        const client = new net.Socket();
        let datosEnviados = false;

        client.setTimeout(config.timeout_conexion_ms || 5000);

        client.on('connect', () => {
            console.log(`[DEBUG] ✅ Socket conectado exitosamente a ${ip}:${puerto}`);
            
            client.write(bytes, (err) => {
                if (err) {
                    console.error(`[DEBUG] ❌ Error al escribir en el socket:`, err);
                    client.destroy();
                    return reject(err);
                }
                datosEnviados = true;
                console.log(`[DEBUG] ✅ Bytes enviados correctamente (${bytes.length} bytes)`);
                
                // 🔑 CLAVE: Esperar un poco antes de cerrar para que la impresora procese el buffer
                setTimeout(() => {
                    client.end();
                }, 500);
            });
        });

        client.on('timeout', () => {
            console.error(`[DEBUG] ⏱️ Timeout al conectar con ${ip}:${puerto}`);
            client.destroy();
            reject(new Error('Timeout de conexión'));
        });

        client.on('error', (err) => {
            console.error(`[DEBUG] ❌ Error de socket [${err.code}]: ${err.message}`);
            client.destroy();
            reject(err);
        });

        client.on('close', () => {
            if (datosEnviados) {
                resolve(true);
            } else {
                reject(new Error('Conexión cerrada antes de enviar datos'));
            }
        });

        client.connect(puerto, ip);
    });
}

// ============================================
// CICLO PRINCIPAL DEL AGENTE
// ============================================
let procesando = false; // Evita solapamiento de ciclos

async function ciclo() {
    // Evitar que se ejecuten dos ciclos al mismo tiempo
    if (procesando) {
        if (config.debug) log('Ciclo anterior aún en ejecución, omitiendo...', 'WARN');
        return;
    }

    procesando = true;

    try {
        // 1. Consultar si hay trabajo pendiente
        const response = await api.get('/cola-impresion', {
			params: {
				sucursal: config.sucursal
			}
		});
        const trabajo = response.data.data;

        if (!trabajo) {
			if (config.debug) log('Sin trabajos pendientes', 'INFO');
			procesando = false;
			return;
		}
		
		const ip = trabajo.ipv4_destino;
		const puerto = trabajo.puerto;
		const codcola = trabajo.codcola_impresion;

        log(`📋 Trabajo encontrado: ${trabajo.descripcion}`, 'INFO');
        log(`   → Destino: ${ip}:${puerto}`, 'INFO');
        log(`   → Tamaño: ${trabajo.bytes.length} chars (base64)`, 'INFO');

		// Decodificar bytes
		let bytes;
        try {
            bytes = Buffer.from(trabajo.bytes, 'base64');
            log(`   → Bytes decodificados: ${bytes.length} bytes`, 'INFO');
        } catch (error) {
			registrarErrorEnArchivo('Fallo al decodificar Base64 de la cola', error.message);
            log(`Error al decodificar base64: ${error.message}`, 'ERROR');
            procesando = false;
            return;
        }

        // 3. Intentar imprimir
        let intentos = 0;
        let impreso = false;

        while (intentos < config.max_reintentos && !impreso) {
            intentos++;
            try {
                log(`Intento ${intentos}/${config.max_reintentos}...`, 'INFO');
                await enviarAImpresora(ip, puerto, bytes);
                impreso = true;
            } catch (error) {
                registrarErrorEnArchivo(`Fallo de impresión en intento ${intentos} (${ip}:${puerto})`, error.message || error.code);
                log(`Intento ${intentos} falló: ${error.message || error.code}`, 'WARN');
                
                if (intentos < config.max_reintentos) {
                    log(`Reintentando en 2 segundos...`, 'INFO');
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        // 4. Eliminar de la cola si se imprimió
        if (impreso) {
            try {
                await api.delete(`/cola-impresion/${codcola}`);
                log(`✅ Trabajo ${codcola} impreso y eliminado de la cola`, 'OK');
            } catch (error) {
                registrarErrorEnArchivo(`No se pudo eliminar el trabajo ${codcola} de la API`, error.message);
                log(`Error al eliminar trabajo de la API: ${error.message}`, 'ERROR');
            }
        } else {
            log(`❌ No se pudo imprimir después de ${config.max_reintentos} intentos`, 'ERROR');
        }

    } catch (error) {
        let detalle = error.message;
        if (error.response) detalle += ` (Status: ${error.response.status})`;
        
        registrarErrorEnArchivo('Error general en el ciclo de consulta a la API', detalle);
        
        if (error.response) {
            log(`Error API ${error.response.status}: ${error.response.statusText}`, 'ERROR');
        } else if (error.request) {
            log(`No se pudo conectar con el servidor (¿Sin internet o VPS caído?)`, 'ERROR');
        } else {
            log(`Error inesperado: ${error.message}`, 'ERROR');
        }
    } finally {
        procesando = false;
    }
}

// ============================================
// INICIO DEL AGENTE
// ============================================
console.log('');
console.log('╔═════════════════════════════════════════════════╗');
console.log('║       Agente de Impresión LCS v1.0              ║');
console.log('╠═════════════════════════════════════════════════╣');
console.log(`║  API:        ${config.url_api.padEnd(35)}║`);
console.log(`║  Intervalo:  ${(config.intervalo_ms + ' ms').padEnd(35)}║`);
console.log(`║  Timeout:    ${(config.timeout_impresion_ms + ' ms').padEnd(35)}║`);
console.log(`║  Reintentos: ${String(config.max_reintentos).padEnd(35)}║`);
console.log(`║  Debug:      ${String(config.debug).padEnd(35)}║`);
console.log('╠═════════════════════════════════════════════════╣');
console.log('║  Presiona Ctrl+C para detener                   ║');
console.log('╚═════════════════════════════════════════════════╝');
console.log('');

log('Agente iniciado. Esperando trabajos...', 'OK');

// Ejecutar inmediatamente al iniciar
ciclo();

// Luego ejecutar cada X milisegundos
setInterval(ciclo, config.intervalo_ms);

// Manejo de cierre graceful
process.on('SIGINT', () => {
    console.log('');
    log('Agente detenido por el usuario', 'WARN');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    log(`Error no capturado: ${error.message}`, 'ERROR');
    log(error.stack, 'ERROR');
});

process.on('unhandledRejection', (reason) => {
    log(`Promesa rechazada: ${reason}`, 'ERROR');
});