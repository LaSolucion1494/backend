import app from './app.js';
import { PORT } from './config.js';
import './db.js';

async function main() {

  // Asegúrate de escuchar en todas las interfaces (0.0.0.0) y en el puerto correcto
  app.listen(PORT || 4486, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });

}

main();

 