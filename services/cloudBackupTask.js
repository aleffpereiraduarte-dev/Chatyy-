// [backup-nuvem 2026-10-22] Tarefa de 2º plano do backup v4 (services/cloudBackup.js) definida no
// TOP-LEVEL: quando o SO acorda o app sem UI (iOS BGTaskScheduler / Android WorkManager, via
// expo-background-task que já está no binário), o executor recarrega o bundle e só acha tarefas
// definidas sincronamente no startup. Registrar/agendar continua no cloudBackup.startRunner (flag).
// Flag desligada = a tarefa nem é agendada; se já estava, o corpo sai na hora (runBackgroundTask).
import { Platform } from 'react-native';

if (Platform.OS !== 'web') {
  try { require('./cloudBackup').defineBackgroundTask(); } catch {}
}
