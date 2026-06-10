module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '\\.(css|scss)$': 'identity-obj-proxy',
  },
  transform: { '^.+\\.(ts|tsx|js|jsx)$': 'babel-jest' },
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}'],
}
