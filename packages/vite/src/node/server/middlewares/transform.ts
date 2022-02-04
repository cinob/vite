import type { ViteDevServer } from '..'
import type { Connect } from 'types/connect'
import {
  cleanUrl,
  createDebugger,
  injectQuery,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  unwrapId
} from '../../utils'
import { send } from '../send'
import { transformRequest } from '../transformRequest'
import { isHTMLProxy } from '../../plugins/html'
import colors from 'picocolors'
import { DEP_VERSION_RE, NULL_BYTE_PLACEHOLDER } from '../../constants'
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest
} from '../../plugins/css'
import {
  ERROR_CODE_OPTIMIZE_DEPS_TIMEOUT,
  ERROR_CODE_OPTIMIZE_DEPS_OUTDATED
} from '../../plugins/optimizedDeps'
import { createIsOptimizedDepUrl } from '../../optimizer'

const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

const knownIgnoreList = new Set(['/', '/favicon.ico'])

export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  const {
    config: { root, logger },
    moduleGraph
  } = server

  const isOptimizedDepUrl = createIsOptimizedDepUrl(server.config)

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteTransformMiddleware(req, res, next) {
    if (req.method !== 'GET' || knownIgnoreList.has(req.url!)) {
      return next()
    }

    let url: string
    try {
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        '\0'
      )
    } catch (e) {
      return next(e)
    }

    const withoutQuery = cleanUrl(url)

    try {
      const isSourceMap = withoutQuery.endsWith('.map')
      // since we generate source map references, handle those requests here
      if (isSourceMap) {
        const originalUrl = url.replace(/\.map($|\?)/, '$1')
        const map = (await moduleGraph.getModuleByUrl(originalUrl, false))
          ?.transformResult?.map
        if (map) {
          return send(req, res, JSON.stringify(map), 'json', {
            headers: server.config.server.headers
          })
        } else {
          return next()
        }
      }

      // check if public dir is inside root dir
      const publicDir = normalizePath(server.config.publicDir)
      const rootDir = normalizePath(server.config.root)
      if (publicDir.startsWith(rootDir)) {
        const publicPath = `${publicDir.slice(rootDir.length)}/`
        // warn explicit public paths
        if (url.startsWith(publicPath)) {
          logger.warn(
            colors.yellow(
              `files in the public directory are served at the root path.\n` +
                `Instead of ${colors.cyan(url)}, use ${colors.cyan(
                  url.replace(publicPath, '/')
                )}.`
            )
          )
        }
      }

      if (
        isJSRequest(url) ||
        isImportRequest(url) ||
        isCSSRequest(url) ||
        isHTMLProxy(url)
      ) {
        // strip ?import
        url = removeImportQuery(url)
        // Strip valid id prefix. This is prepended to resolved Ids that are
        // not valid browser import specifiers by the importAnalysis plugin.
        url = unwrapId(url)

        // for CSS, we need to differentiate between normal CSS requests and
        // imports
        if (
          isCSSRequest(url) &&
          !isDirectRequest(url) &&
          req.headers.accept?.includes('text/css')
        ) {
          url = injectQuery(url, 'direct')
        }

        // check if we can return 304 early
        const ifNoneMatch = req.headers['if-none-match']
        if (
          ifNoneMatch &&
          (await moduleGraph.getModuleByUrl(url, false))?.transformResult
            ?.etag === ifNoneMatch
        ) {
          isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
          res.statusCode = 304
          return res.end()
        }

        // resolve, load and transform using the plugin container
        const result = await transformRequest(url, server, {
          html: req.headers.accept?.includes('text/html')
        })
        if (result) {
          const type = isDirectCSSRequest(url) ? 'css' : 'js'
          const isDep = DEP_VERSION_RE.test(url) || isOptimizedDepUrl(url)
          return send(req, res, result.code, type, {
            etag: result.etag,
            // allow browser to cache npm deps!
            cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache',
            headers: server.config.server.headers,
            map: result.map
          })
        }
      }
    } catch (e) {
      if (e?.code === ERROR_CODE_OPTIMIZE_DEPS_TIMEOUT) {
        if (!res.writableEnded) {
          // Don't do anything if response has already been sent
          res.statusCode = 504 // status code request timeout
          res.end()
        }
        logger.error(e.message)
        return
      }
      if (e?.code === ERROR_CODE_OPTIMIZE_DEPS_OUTDATED) {
        if (!res.writableEnded) {
          // Don't do anything if response has already been sent
          res.statusCode = 504 // status code request timeout
          res.end()
        }
        logger.error(e.message)
        return
      }
      return next(e)
    }

    next()
  }
}
