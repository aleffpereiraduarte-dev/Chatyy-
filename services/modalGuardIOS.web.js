// [2026-10-17 freeze] Web: sem guarda de Modal (o módulo nativo usa
// react-native/Libraries/Modal/Modal, que não existe no react-native-web).
export function getOpenModals() { return []; }
export function modalGuardInstalled() { return false; }
