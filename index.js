import fetch from "node-fetch";
import cheerio from "cheerio";
import fs from 'fs'
import path from 'path'
import mime from 'mime-types'
import stream from 'stream'
import util from 'util'
import sanitize from "sanitize-filename";

const streamPipeline = util.promisify(stream.pipeline)

const id = process.argv[2]
const sessionId = process.argv[3]

const cachePath = 'cache.json'
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath)) : {}

async function ParseMainPage(pageIndex) {
    const url = `https://fantia.jp/fanclubs/${id}/posts?page=${pageIndex}`

    if (cache[id].parsed.includes(pageIndex)) {
        console.log(`Skip ParseMainPage: ${pageIndex}`)
        return [1, []]
    }
    else {
        console.error(`Running ParseMainPage: ${pageIndex}`)
    }

    const resp = await fetch(url)
    const text = await resp.text()
    const $ = cheerio.load(text)
    const blocks = $('.post')
    const result = []
    for (const block of blocks) {
        const title = $('.post-title', $(block)).text()
        const id = $('a', $(block)).attr('href').replace('/posts/', '')
        result.push({ title, id })
    }
    return [0, result]
}

async function ParseImgSrc(url) {
    const resp = await fetch(url, {
        headers: {
            Cookie: `_session_id=${sessionId}`
        }
    })
    const text = await resp.text()
    const $ = cheerio.load(text)
    const src = $('img').attr('src')
    return src
}

async function ParsePost(task) {

    if (cache[id].processed.includes(task.id)) {
        console.log(`\t Skip ParsePost: ${task.id} - ${task.title}`)
        return
    }

    const resp = await fetch(`https://fantia.jp/api/v1/posts/${task.id}`, {
        headers: {
            Cookie: `_session_id=${sessionId}`
        }
    })

    const data = await resp.json()
    const contents = data.post.post_contents.map(x => ({
        id: x.id,
        title: x?.filename ?? x?.title,
        category: x.category,
        photos: x.post_content_photos?.map(x => 'https://fantia.jp/' + x.show_original_uri),
    }))

    const output = JSON.stringify(contents, null, 4).split('\n').map(x => `  ${x}`).join('\n')
    console.log(`\t Parsed: ${output}`)

    if (contents.length == 0) {
        console.log(`\t Skip ${task.id} - ${task.title}`)
        return
    }
    else {
        console.log(`\t Processing ${task.id} - ${task.title}`)
    }

    for (const content of contents) {

        let parentBase = path.join('Storage', id, `${task.id}-${sanitize(task.title)}`)

        if (content.title == null) {
            console.log(`\t Detect title = null. Raw = ${JSON.stringify(content, null, 4)}`)
            console.log(`\t Data = ${JSON.stringify(data, null, 4)}`)
            content.title = '' // refine it
        }

        if (content.category == 'photo_gallery') {
            for (const photo of content.photos) {
                const savePath = path.join(parentBase, content.title, photo.split('/').slice(-1)[0])
                const src = await ParseImgSrc(photo)
                await SaveBinary(src, savePath)
            }
        }

        else if (content.category == 'file') {
            await SaveBinary(`https://fantia.jp/posts/${task.id}/download/${content.id}`, path.join(parentBase, `${sanitize(content.title)}`))
        }

        cache[id].processed.push(task.id)
        if (cache[id].processed.length % 3 == 0) {
            fs.writeFileSync(cachePath, JSON.stringify(cache, null, 4))
        }
    }
}

async function SaveBinary(url, savePath) {
    const folderPath = path.dirname(savePath)
    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true })
    }

    console.log(`\t Start download ${url} as ${savePath}\n`)
    const resp = await fetch(url, {
        redirect: 'follow',
        headers: {
            Cookie: `_session_id=${sessionId}`
        }
    })
    const contentType = resp.headers.get('content-type')
    const extension = contentType == 'binary/octet-stream'
        ? 'zip' // default chooose zip
        : mime.extension(contentType)
    const filename = (savePath.includes('.mp4') || savePath.includes('.zip'))
        ? savePath
        : `${savePath}.${extension}`
    await streamPipeline(resp.body, fs.createWriteStream(filename))
}

async function Run() {

    if (id in cache == false) {
        cache[id] = {
            parsed: [],
            posts: [],
            processed: [],
        }
    }

    let pageIndex = 1
    while (true) {
        const [status, result] = await ParseMainPage(pageIndex)
        if (status == 0 && result.length == 0) {
            break
        }

        result.map(x => cache[id].posts.push(x))
        if (!cache[id].parsed.includes(pageIndex)) {
            cache[id].parsed.push(pageIndex)
        }
        pageIndex += 1
    }

    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 4))

    for (let i = 0; i < cache[id].posts.length; ++i) {
        console.log(`> ParsePost: ${i + 1}/${cache[id].posts.length}`)
        await ParsePost(cache[id].posts[i])
    }
}

Run()