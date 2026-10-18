// [2026-10-18 email-reader-rea] Web: sem swipe entre e-mails (setas/atalhos do
// teclado no read.js). A versão de thread de UI mora em ReaderSwipePager.native.js.
export const READER_SWIPE_REA = false;
export function isReaderReaOn() { return false; }
export default function ReaderSwipePager({ children }) { return children; }
