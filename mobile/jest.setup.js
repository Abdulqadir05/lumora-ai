/* Test-only mocks for native modules. Network (fetch / expo/fetch) is mocked per test. */
import mockAsyncStorage from '@react-native-async-storage/async-storage/jest/async-storage-mock';

jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light' },
}));
jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: View };
});
jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

// The Jest renderer has no native view tags, so run native-driver animations on the JS driver in tests only.
const { Animated } = require('react-native');
['timing', 'spring', 'decay'].forEach((name) => {
  const original = Animated[name];
  Animated[name] = (value, config) => original(value, { ...config, useNativeDriver: false });
});
