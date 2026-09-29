const net = require('net');
const client = new net.Socket();

const ip = '192.168.1.76';
const port = 9100; // Cambia esto si descubres que es otro puerto

console.log(`🔍 Intentando conectar a ${ip}:${port}...`);

client.connect(port, ip, () => {
    console.log('✅ ¡Conexión exitosa! La impresora está escuchando en este puerto.');
    // Envía un comando de inicialización y un texto de prueba
    client.write(Buffer.from('\x1B\x40')); 
    client.write('¡HOLA DESDE NODE.JS!\n\n\n\n');
    client.end();
});

client.on('error', (err) => {
    console.error(`❌ Error de conexión: ${err.code}`);
    console.log('\nPosibles causas:');
    console.log('1. El puerto no es 9100 (revisa la página de configuración de red de la impresora).');
    console.log('2. La impresora está en modo de suspensión (presiona un botón para despertarla).');
    console.log('3. Es una impresora USB compartida desde otra PC (la IP debe ser la de esa PC, no la de la impresora).');
    console.log('4. Un firewall está bloqueando el puerto 9100.');
});