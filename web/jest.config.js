const nextJest = require('next/jest')
const createJestConfig = nextJest({ dir: './' })

module.exports = createJestConfig({
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '\\.(css|scss)$': 'identity-obj-proxy',
  },
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}'],
})
