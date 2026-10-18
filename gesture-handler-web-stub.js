// Stub for react-native-gesture-handler on web platform
// Prevents TDZ error "Cannot access 'xt' before initialization"
// [2026-10-18] Componentes viram passthrough (antes eram undefined → React #130
// no NotificationToast da web, que usa PanGestureHandler).
import { View } from 'react-native';

const Passthrough = ({ children }) => children ?? null;
const RootView = (props) => <View {...props} />;

export const State = { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 };
export const Directions = { RIGHT: 1, LEFT: 2, UP: 4, DOWN: 8 };

export const PanGestureHandler = Passthrough;
export const TapGestureHandler = Passthrough;
export const LongPressGestureHandler = Passthrough;
export const PinchGestureHandler = Passthrough;
export const FlingGestureHandler = Passthrough;
export const GestureDetector = Passthrough;
export const GestureHandlerRootView = RootView;
export const Swipeable = undefined;

// Gesture builder: every method returns the same chainable no-op.
const _chain = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : () => _chain),
  apply: () => _chain,
});
export const Gesture = new Proxy({}, { get: () => () => _chain });

export default { State, Directions };
