import mysql from 'mysql2/promise';
import { MYSQL_PUBLIC_URL } from './config.js';

let pool;

try {
     // Crear un pool de conexiones
     pool = mysql.createPool({
        uri: MYSQL_PUBLIC_URL,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        timezone: 'Z', 
    });

     // Probar la conexión
     const testConnection = async () => {
        try {
            const connection = await pool.getConnection();
            console.log('Conexión a la base de datos establecida correctamente');
            connection.release(); // Liberar la conexión al pool
        } catch (err) {
            console.error('Error al conectar a la base de datos:', err.message);
            process.exit(1); // Detener el servidor si no se puede conectar
        }
    };

    testConnection();
} catch (err) {
    console.error('Error al configurar el pool de conexiones:', err.message);
    process.exit(1); // Detener el servidor si ocurre un error crítico al configurar el pool
}

// Exportar el pool
export default pool;
