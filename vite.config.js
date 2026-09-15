import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export default {
    root: 'src/',
    publicDir: '../static/',
    server:
    {
        host: '127.0.0.1'
    },
    build:
    {
        outDir: '../dist',
        emptyOutDir: true,
        sourcemap: true
    },
    plugins:
    [
        {
            name: 'save-local-forge-capture',
            configureServer(server)
            {
                server.middlewares.use('/__capture', async (request, response, next) =>
                {
                    if(request.method !== 'POST')
                    {
                        next()
                        return
                    }

                    const chunks = []
                    let size = 0

                    for await(const chunk of request)
                    {
                        size += chunk.length

                        if(size > 50 * 1024 * 1024)
                        {
                            response.statusCode = 413
                            response.end('Capture exceeds the 50 MB limit.')
                            return
                        }

                        chunks.push(chunk)
                    }

                    const mediaDirectory = path.resolve(process.cwd(), 'media')
                    await mkdir(mediaDirectory, { recursive: true })
                    await writeFile(path.join(mediaDirectory, 'starfall-forge-capture.webm'), Buffer.concat(chunks))

                    response.statusCode = 201
                    response.end('Capture saved.')
                })
            }
        }
    ]
}
