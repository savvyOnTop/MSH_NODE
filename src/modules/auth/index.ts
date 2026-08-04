// Public interface of the auth module.
export { authRoutes } from './routes.js';
export {
  issueTokens,
  provisionUser,
  refreshTokens,
  logout,
} from './service.js';
export {
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
} from './jwt.js';
