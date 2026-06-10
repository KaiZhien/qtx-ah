import '@testing-library/jest-dom'
jest.mock('next/navigation', () => ({ useRouter: () => ({}) }))
// Suppress React 18 act() warnings in jsdom test environment
global.IS_REACT_ACT_ENVIRONMENT = true
