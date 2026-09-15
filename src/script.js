import * as THREE from 'three/webgpu'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import {
    color,
    deltaTime,
    Fn,
    grayscale,
    hash,
    If,
    instancedArray,
    instanceIndex,
    materialColor,
    mix,
    mul,
    pass,
    positionGeometry,
    range,
    TWO_PI,
    uniform,
    uv,
    vec3
} from 'three/tsl'

/**
 * Starfall Forge
 *
 * The visual ideas are deliberately close to the Anvil lesson: an animated
 * hammer, a TSL emissive heat field, a brief point-light flash, GPU-computed
 * sparks, bloom and easing in the animation loop. The anvil model and floor
 * texture are loaded from the supplied lesson archive.
 */

const $ = (selector) => document.querySelector(selector)

const ui = {
    loading: $('[data-loading]'),
    startPanel: $('[data-start-panel]'),
    startButton: $('[data-start-button]'),
    hud: $('[data-hud]'),
    strikeConsole: $('[data-strike-console]'),
    resultPanel: $('[data-result-panel]'),
    restartButton: $('[data-restart-button]'),
    time: $('[data-time]'),
    score: $('[data-score]'),
    combo: $('[data-combo]'),
    progressFill: $('[data-progress-fill]'),
    progressLabel: $('[data-progress-label]'),
    heatFill: $('[data-heat-fill]'),
    heatLabel: $('[data-heat-label]'),
    heatMeter: $('.meter--heat'),
    marker: $('[data-marker]'),
    sweetZone: $('[data-sweet-zone]'),
    feedback: $('[data-feedback]'),
    resultKicker: $('[data-result-kicker]'),
    resultTitle: $('[data-result-title]'),
    resultCopy: $('[data-result-copy]'),
    finalScore: $('[data-final-score]'),
    bestScore: $('[data-best-score]'),
    announcement: $('[data-announcement]')
}

const canvas = $('canvas.threejs')

/**
 * Game state
 */
const GAME_DURATION = 30
const state = {
    status: 'intro',
    elapsed: 0,
    timeLeft: GAME_DURATION,
    score: 0,
    combo: 0,
    heat: 32,
    progress: 0,
    targetCenter: 0.5,
    targetWidth: 0.18,
    timingPosition: 0,
    strikeCooldown: 0,
    feedbackTimer: 0,
    cameraShake: 0
}

const clamp = THREE.MathUtils.clamp
const formatScore = (value) => Math.round(value).toString().padStart(4, '0')

let storedBest = 0
try
{
    storedBest = Number(localStorage.getItem('starfall-forge-best')) || 0
}
catch
{
    // Private browsing may block storage. The game still works without it.
}

/**
 * Scene
 */
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x070711)
scene.fog = new THREE.FogExp2(0x080812, 0.065)

const sizes = {
    width: window.innerWidth,
    height: window.innerHeight
}

const camera = new THREE.PerspectiveCamera(38, sizes.width / sizes.height, 0.1, 100)
camera.position.set(5.2, 4.15, 3.1)
camera.lookAt(0, 1.55, 0)
scene.add(camera)

const cameraBase = camera.position.clone()
const pointer = new THREE.Vector2()

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(sizes.width, sizes.height)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.1

/**
 * Bloom turns values brighter than the normal color range into a soft glow.
 */
const renderPipeline = new THREE.RenderPipeline(renderer)
const scenePass = pass(scene, camera)
const sceneColor = scenePass.getTextureNode('output')
const bloomPass = bloom(sceneColor)
bloomPass.threshold.value = 0.75
bloomPass.strength.value = 0.22
bloomPass.radius.value = 0.55
renderPipeline.outputNode = sceneColor.add(bloomPass)

/**
 * Floor — including the TSL radial opacity technique explored in the lesson.
 */
const textureLoader = new THREE.TextureLoader()
const gltfLoader = new GLTFLoader()
const floorTexture = textureLoader.load(`${import.meta.env.BASE_URL}floor-color.jpg`)
floorTexture.colorSpace = THREE.SRGBColorSpace

const floorMaterial = new THREE.MeshStandardNodeMaterial({
    map: floorTexture,
    transparent: true
})
floorMaterial.opacityNode = uv().sub(0.5).length().smoothstep(0.5, 0.2)

const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), floorMaterial)
floor.rotation.x = -Math.PI * 0.5
floor.receiveShadow = true
scene.add(floor)

const floorRuneMaterial = new THREE.MeshBasicMaterial({
    color: 0x503884,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    blending: THREE.AdditiveBlending
})

for(const radius of [2.2, 3.35, 4.7])
{
    const floorRune = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.012, 96), floorRuneMaterial)
    floorRune.rotation.x = -Math.PI * 0.5
    floorRune.position.y = 0.008
    scene.add(floorRune)
}

/**
 * Star field
 */
const starPositions = new Float32Array(900 * 3)
for(let i = 0; i < 900; i++)
{
    const radius = THREE.MathUtils.randFloat(9, 32)
    const theta = Math.random() * Math.PI * 2
    const y = THREE.MathUtils.randFloat(1.5, 17)
    starPositions[i * 3 + 0] = Math.cos(theta) * radius
    starPositions[i * 3 + 1] = y
    starPositions[i * 3 + 2] = Math.sin(theta) * radius
}

const starsGeometry = new THREE.BufferGeometry()
starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
const stars = new THREE.Points(
    starsGeometry,
    new THREE.PointsMaterial({ color: 0xb8afff, size: 0.035, transparent: true, opacity: 0.72, sizeAttenuation: true })
)
scene.add(stars)

/**
 * Original lesson model
 */
const model = await gltfLoader.loadAsync(`${import.meta.env.BASE_URL}anvil.glb`)
model.scene.traverse((child) =>
{
    if(!child.isMesh)
        return

    child.castShadow = true
    child.receiveShadow = true
})
scene.add(model.scene)

const hammer = model.scene.getObjectByName('hammer')
const blade = model.scene.getObjectByName('blade')

if(!hammer || !blade)
    throw new Error('The lesson anvil model is missing its hammer or blade mesh.')

hammer.rotation.reorder('YXZ')
blade.material = new THREE.MeshPhysicalNodeMaterial().copy(blade.material)

/**
 * Original lesson blade effect, driven by the game strikes.
 */
const bladeEffectStrength = uniform(0)
const bladeColorA = uniform(color(0xff007b))
const bladeColorB = uniform(color(0xffb070))
const bladeEmissiveStrength = uniform(1.5)

blade.material.emissiveNode = Fn(() =>
{
    const mask = grayscale(materialColor.rgb).remapClamp(0, 0.13, 1, 0)
    const distanceToImpact = positionGeometry.sub(vec3(0, 0, 0.3)).length()
    const effect = mask
        .sub(distanceToImpact.mul(2))
        .add(bladeEffectStrength)
        .max(0)
        .pow(2)

    return mul(
        mix(bladeColorA, bladeColorB, effect),
        effect,
        bladeEmissiveStrength
    )
})()

/**
 * Progress sigils make the game state part of the 3D world.
 */
const forgeProgress = uniform(0)
const sigilMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x05050a,
    roughness: 0.25,
    metalness: 0.3,
    transparent: true,
    opacity: 0.4,
    depthWrite: false
})
sigilMaterial.emissiveNode = mix(color(0x5d4bff), color(0xffd38c), forgeProgress).mul(forgeProgress.add(0.08), 6)

const sigilGroup = new THREE.Group()
sigilGroup.position.set(0.06, 2.14, -0.06)

const sigilOuter = new THREE.Mesh(new THREE.TorusGeometry(0.69, 0.012, 8, 96), sigilMaterial)
sigilOuter.rotation.x = Math.PI * 0.5
sigilGroup.add(sigilOuter)

const sigilInner = new THREE.Mesh(new THREE.TorusGeometry(0.49, 0.006, 8, 64), sigilMaterial)
sigilInner.rotation.x = Math.PI * 0.5
sigilGroup.add(sigilInner)

for(let i = 0; i < 8; i++)
{
    const rune = new THREE.Mesh(new THREE.OctahedronGeometry(0.035, 0), sigilMaterial)
    const angle = i / 8 * Math.PI * 2
    rune.position.set(Math.cos(angle) * 0.59, 0, Math.sin(angle) * 0.59)
    rune.scale.set(0.7, 2.4, 0.7)
    sigilGroup.add(rune)
}
scene.add(sigilGroup)

/**
 * Lights
 */
const keyLight = new THREE.DirectionalLight(0xffa27a, 3.1)
keyLight.position.set(-1.8, 4.2, 2.5)
keyLight.castShadow = true
keyLight.shadow.radius = 5
keyLight.shadow.normalBias = 0.08
keyLight.shadow.mapSize.set(1024, 1024)
scene.add(keyLight)

const ambientLight = new THREE.AmbientLight(0x635dff, 1.75)
scene.add(ambientLight)

const hemisphereLight = new THREE.HemisphereLight(0x9589ff, 0x2b1018, 1.6)
scene.add(hemisphereLight)

const rimLight = new THREE.PointLight(0x725cff, 16, 7, 2)
rimLight.position.set(-2.2, 3, -2.4)
scene.add(rimLight)

const impactLight = new THREE.PointLight(0xff955c, 2.5, 5, 2)
impactLight.position.set(0.4, 2.65, 0.35)
scene.add(impactLight)

/**
 * GPU spark simulation — positions, velocities and life all stay in storage
 * buffers and are updated in parallel by a TSL compute function.
 */
const SPARK_COUNT = 2400
const SPARKS_PER_HIT = 180
const positions = instancedArray(SPARK_COUNT, 'vec3')
const velocities = instancedArray(SPARK_COUNT, 'vec3')
const lives = instancedArray(SPARK_COUNT, 'float')

const sparkIndex = uniform(0, 'int')
const sparkScale = uniform(0.026)
const sparkDecay = uniform(0.38)
const sparkColorA = uniform(color(0xff7a4d))
const sparkColorB = uniform(color(0x8168ff))

const sparkMaterial = new THREE.SpriteNodeMaterial({ color: 0x000000 })
sparkMaterial.positionNode = positions.element(instanceIndex)
sparkMaterial.scaleNode = sparkScale
    .mul(range(0.55, 1.25))
    .mul(lives.element(instanceIndex).remapClamp(0.46, 1, 1, 0))
sparkMaterial.emissiveNode = mix(
    sparkColorA,
    sparkColorB,
    hash(instanceIndex.add(345).mul(4)).smoothstep(0, 1)
).mul(38).toVertexStage()

const sparks = new THREE.Sprite(sparkMaterial)
sparks.count = SPARK_COUNT
sparks.frustumCulled = false
scene.add(sparks)

const sparkExplosion = Fn(() =>
{
    const newIndex = instanceIndex.add(sparkIndex).mod(SPARK_COUNT)
    const position = positions.element(newIndex)
    const velocity = velocities.element(newIndex)
    const life = lives.element(newIndex)

    position.assign(vec3(0.05, 1.95, -0.1))

    const angle = hash(newIndex).mul(TWO_PI)
    const direction = vec3(
        angle.sin(),
        hash(newIndex.add(123).mul(2)).mul(1.35),
        angle.cos()
    )
    velocity.assign(direction.mul(3.25))
    life.assign(hash(newIndex.add(234).mul(3)))
})().compute(SPARKS_PER_HIT)

const sparkUpdate = Fn(() =>
{
    const position = positions.element(instanceIndex)
    const velocity = velocities.element(instanceIndex)
    const life = lives.element(instanceIndex)

    velocity.y.subAssign(deltaTime.mul(9.81))
    position.addAssign(velocity.mul(deltaTime))

    If(position.y.lessThan(0.05), () =>
    {
        position.y.assign(0.05)
        velocity.mulAssign(vec3(0.88, -0.46, 0.88))
    })

    life.assign(life.add(sparkDecay.mul(deltaTime)).min(1))
})().compute(SPARK_COUNT)

/**
 * A simple expanding ring gives every strike an extra visual "thump".
 */
const shockwaveMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd6a0,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending
})
const shockwave = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.19, 64), shockwaveMaterial)
shockwave.position.set(0.05, 1.97, -0.1)
shockwave.rotation.x = -Math.PI * 0.5
scene.add(shockwave)
let shockwaveLife = 1

/**
 * Sound is generated in the browser so the project needs no audio assets.
 */
let audioContext = null

const ensureAudio = () =>
{
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)()
    if(audioContext.state === 'suspended')
        audioContext.resume()
}

const playImpactSound = (rating = 'good') =>
{
    ensureAudio()
    const now = audioContext.currentTime
    const master = audioContext.createGain()
    master.gain.setValueAtTime(0.0001, now)
    master.gain.exponentialRampToValueAtTime(rating === 'perfect' ? 0.24 : 0.16, now + 0.006)
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.42)
    master.connect(audioContext.destination)

    const body = audioContext.createOscillator()
    body.type = 'triangle'
    body.frequency.setValueAtTime(rating === 'perfect' ? 132 : 112, now)
    body.frequency.exponentialRampToValueAtTime(54, now + 0.2)
    body.connect(master)
    body.start(now)
    body.stop(now + 0.24)

    const ring = audioContext.createOscillator()
    const ringGain = audioContext.createGain()
    ring.type = 'sine'
    ring.frequency.setValueAtTime(rating === 'perfect' ? 920 : 610, now)
    ring.frequency.exponentialRampToValueAtTime(330, now + 0.33)
    ringGain.gain.setValueAtTime(0.12, now)
    ringGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34)
    ring.connect(ringGain).connect(master)
    ring.start(now)
    ring.stop(now + 0.35)
}

/**
 * UI and game rules
 */
const updateHud = () =>
{
    ui.time.textContent = state.timeLeft.toFixed(1)
    ui.score.textContent = formatScore(state.score)
    ui.combo.textContent = state.combo

    const progress = clamp(state.progress, 0, 100)
    ui.progressFill.style.width = `${progress}%`
    ui.progressLabel.textContent = `${Math.round(progress)}%`

    const heat = clamp(state.heat, 0, 100)
    ui.heatFill.style.width = `${heat}%`
    ui.heatLabel.textContent = `${Math.round(heat)}%`
    ui.heatMeter.classList.toggle('is-danger', heat >= 88)
}

const setFeedback = (message, tone = '') =>
{
    ui.feedback.textContent = message
    ui.feedback.dataset.tone = tone
    state.feedbackTimer = 1.1
    ui.announcement.textContent = message
}

const moveTarget = () =>
{
    const previous = state.targetCenter
    let next = previous

    while(Math.abs(next - previous) < 0.16)
        next = THREE.MathUtils.randFloat(0.17, 0.83)

    state.targetCenter = next
    state.targetWidth = THREE.MathUtils.lerp(0.2, 0.115, state.progress / 100)
    ui.sweetZone.style.left = `${(state.targetCenter - state.targetWidth * 0.5) * 100}%`
    ui.sweetZone.style.width = `${state.targetWidth * 100}%`
}

const startGame = () =>
{
    ensureAudio()
    Object.assign(state, {
        status: 'playing',
        elapsed: 0,
        timeLeft: GAME_DURATION,
        score: 0,
        combo: 0,
        heat: 32,
        progress: 0,
        targetCenter: 0.5,
        targetWidth: 0.2,
        timingPosition: 0,
        strikeCooldown: 0,
        feedbackTimer: 0,
        cameraShake: 0
    })

    bladeEffectStrength.value = 0
    forgeProgress.value = 0
    ui.startPanel.classList.add('is-hidden')
    ui.resultPanel.classList.add('is-hidden')
    ui.hud.classList.remove('is-hidden')
    ui.strikeConsole.classList.remove('is-hidden')
    setFeedback('Watch the comet…')
    moveTarget()
    updateHud()
}

const finishGame = (won) =>
{
    if(state.status !== 'playing')
        return

    state.status = won ? 'won' : 'lost'
    state.timeLeft = Math.max(0, state.timeLeft)
    ui.hud.classList.add('is-hidden')
    ui.strikeConsole.classList.add('is-hidden')

    if(won)
    {
        const timeBonus = Math.round(state.timeLeft * 35)
        state.score += timeBonus
        ui.resultKicker.textContent = 'Commission complete'
        ui.resultTitle.textContent = 'A star is born.'
        ui.resultCopy.textContent = `Celestial edge secured with a ${timeBonus}-point time bonus.`
    }
    else
    {
        ui.resultKicker.textContent = 'The star went dark'
        ui.resultTitle.textContent = 'Almost forged.'
        ui.resultCopy.textContent = `The blade reached ${Math.round(state.progress)}% form. Better timing will keep the core hot without overheating it.`
    }

    storedBest = Math.max(storedBest, Math.round(state.score))
    try
    {
        localStorage.setItem('starfall-forge-best', storedBest)
    }
    catch
    {
        // Best score remains available for this session.
    }

    ui.finalScore.textContent = formatScore(state.score)
    ui.bestScore.textContent = formatScore(storedBest)
    ui.resultPanel.classList.remove('is-hidden')
    ui.announcement.textContent = won ? 'Blade forged.' : 'Time expired.'
}

const strike = () =>
{
    if(state.status !== 'playing' || state.strikeCooldown > 0)
        return

    state.strikeCooldown = 0.28

    const distance = Math.abs(state.timingPosition - state.targetCenter)
    const halfWindow = state.targetWidth * 0.5
    let rating = 'miss'

    if(distance <= halfWindow * 0.36)
        rating = 'perfect'
    else if(distance <= halfWindow)
        rating = 'good'

    // Every player action drives the same audiovisual stack used in the lesson.
    hammer.rotation.x = Math.PI * 0.5
    bladeEffectStrength.value += 0.15
    impactLight.intensity += rating === 'perfect' ? 23 : 15
    state.cameraShake = rating === 'perfect' ? 1 : 0.62
    shockwaveLife = 0
    shockwave.scale.setScalar(0.55)
    shockwaveMaterial.opacity = rating === 'miss' ? 0.36 : 0.72
    sparkColorB.value.set(rating === 'perfect' ? 0xffd68b : rating === 'good' ? 0xa779ff : 0x5d4bff)
    renderer.compute(sparkExplosion)
    sparkIndex.value = (sparkIndex.value + SPARKS_PER_HIT) % SPARK_COUNT
    playImpactSound(rating)

    state.heat = clamp(state.heat + (rating === 'perfect' ? 15 : rating === 'good' ? 12 : 9), 0, 100)
    const idealHeat = state.heat >= 38 && state.heat <= 82

    if(state.heat >= 95)
    {
        state.combo = 0
        state.progress = Math.max(0, state.progress - 10)
        state.score = Math.max(0, state.score - 80)
        state.heat = 88
        setFeedback('Overheated — let it breathe!', 'miss')
    }
    else if(rating === 'perfect' && idealHeat)
    {
        state.combo += 1
        const comboBonus = Math.min(state.combo, 8)
        state.progress += 13 + comboBonus * 0.75
        state.score += 120 + comboBonus * 28
        setFeedback(state.combo > 2 ? `Perfect — ${state.combo}× celestial streak` : 'Perfect strike', 'perfect')
    }
    else if(rating === 'perfect')
    {
        state.combo = Math.max(1, state.combo)
        state.progress += 7
        state.score += 75
        setFeedback(state.heat < 38 ? 'Perfect timing — blade too cold' : 'Perfect timing — running hot', 'good')
    }
    else if(rating === 'good' && idealHeat)
    {
        state.combo += 1
        state.progress += 8.5
        state.score += 70 + Math.min(state.combo, 6) * 14
        setFeedback('Good strike', 'good')
    }
    else if(rating === 'good')
    {
        state.combo = 0
        state.progress += 3
        state.score += 35
        setFeedback('Good timing — watch the heat', 'good')
    }
    else
    {
        state.combo = 0
        state.progress = Math.max(0, state.progress - 3.5)
        state.score = Math.max(0, state.score - 20)
        setFeedback('Glancing blow — find the window', 'miss')
    }

    state.progress = clamp(state.progress, 0, 100)
    moveTarget()
    updateHud()

    if(state.progress >= 100)
        finishGame(true)
}

ui.startButton.addEventListener('click', startGame)
ui.restartButton.addEventListener('click', startGame)

canvas.addEventListener('pointerdown', (event) =>
{
    if(event.button === 0)
        strike()
})

window.addEventListener('keydown', (event) =>
{
    if(event.code !== 'Space' || event.repeat)
        return

    event.preventDefault()

    if(state.status === 'intro')
        startGame()
    else if(state.status === 'playing')
        strike()
    else
        startGame()
})

window.addEventListener('pointermove', (event) =>
{
    pointer.x = event.clientX / sizes.width * 2 - 1
    pointer.y = -(event.clientY / sizes.height * 2 - 1)
})

window.addEventListener('resize', () =>
{
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight
    camera.aspect = sizes.width / sizes.height
    camera.updateProjectionMatrix()
    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
})

/**
 * Animation
 */
const timer = new THREE.Timer()
let totalTime = 0

const tick = () =>
{
    timer.update()
    const dt = Math.min(1 / 30, timer.getDelta())
    totalTime += dt

    if(state.status === 'playing')
    {
        state.elapsed += dt
        state.timeLeft = Math.max(0, GAME_DURATION - state.elapsed)
        state.strikeCooldown = Math.max(0, state.strikeCooldown - dt)
        state.feedbackTimer = Math.max(0, state.feedbackTimer - dt)

        // The moving marker speeds up slightly as the blade nears completion.
        const timingSpeed = 2.35 + state.progress * 0.006
        state.timingPosition = 0.5 + Math.sin(state.elapsed * timingSpeed - Math.PI * 0.5) * 0.485
        ui.marker.style.left = `${state.timingPosition * 100}%`

        state.heat = Math.max(12, state.heat - dt * 6.4)

        if(state.feedbackTimer === 0)
        {
            ui.feedback.textContent = state.heat >= 84 ? 'Careful — the core is unstable' : 'Watch the comet…'
            ui.feedback.dataset.tone = ''
        }

        updateHud()

        if(state.timeLeft <= 0)
            finishGame(false)
    }

    // Frame-rate-independent easing returns the hammer to its rest pose.
    hammer.rotation.x += -hammer.rotation.x * dt
    bladeEffectStrength.value += -bladeEffectStrength.value * dt * 0.5
    forgeProgress.value += (state.progress / 100 - forgeProgress.value) * dt * 2.4
    impactLight.intensity += (2.5 - impactLight.intensity) * dt * 8

    sigilOuter.rotation.z += dt * (0.11 + state.progress * 0.001)
    sigilInner.rotation.z -= dt * 0.17
    sigilGroup.position.y = 2.14 + Math.sin(totalTime * 1.2) * 0.012
    sigilMaterial.opacity = 0.2 + state.progress / 100 * 0.62
    stars.rotation.y += dt * 0.005

    shockwaveLife = Math.min(1, shockwaveLife + dt * 2.8)
    shockwave.scale.setScalar(0.55 + shockwaveLife * 3.4)
    shockwaveMaterial.opacity *= Math.pow(0.015, dt)

    state.cameraShake = Math.max(0, state.cameraShake - dt * 5.2)
    const shake = state.cameraShake * 0.035
    const targetX = cameraBase.x + pointer.x * 0.09 + (Math.random() - 0.5) * shake
    const targetY = cameraBase.y + pointer.y * 0.045 + (Math.random() - 0.5) * shake
    camera.position.x += (targetX - camera.position.x) * dt * 2.2
    camera.position.y += (targetY - camera.position.y) * dt * 2.2
    camera.lookAt(0, 1.55, 0)

    renderer.compute(sparkUpdate)
    renderPipeline.render()
}

renderer.setAnimationLoop(tick)

// Reveal the experience only after the scene is ready.
requestAnimationFrame(() => ui.loading.classList.add('is-hidden'))

/**
 * README capture helper
 *
 * Visiting the local app with `?capture=1` records one clean, UI-free canvas
 * run. It is intentionally opt-in and only used when refreshing the short
 * project demo in `media/`.
 */
const recordDemo = async () =>
{
    if(!canvas.captureStream || typeof MediaRecorder === 'undefined')
    {
        console.warn('Canvas recording is not supported in this browser.')
        return
    }

    const mimeType = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
    ].find((type) => MediaRecorder.isTypeSupported(type))

    if(!mimeType)
    {
        console.warn('No supported WebM recorder was found.')
        return
    }

    const stream = canvas.captureStream(30)
    const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 3_200_000
    })
    const chunks = []

    recorder.addEventListener('dataavailable', (event) =>
    {
        if(event.data.size > 0)
            chunks.push(event.data)
    })

    recorder.addEventListener('stop', async () =>
    {
        const blob = new Blob(chunks, { type: mimeType })
        const response = await fetch('/__capture', {
            method: 'POST',
            headers: { 'Content-Type': mimeType },
            body: blob
        })

        if(!response.ok)
            throw new Error(`Capture export failed with status ${response.status}.`)

        console.info('Forge capture saved to media/starfall-forge-capture.webm')
    })

    recorder.start(250)
    startGame()

    const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration))
    await wait(700)

    for(let i = 0; i < 7; i++)
    {
        // Guarantee a clean strike so the capture reaches the completed sigil.
        state.timingPosition = state.targetCenter
        strike()
        await wait(1250)
    }

    await wait(900)
    recorder.stop()
}

if(new URLSearchParams(window.location.search).get('capture') === '1')
{
    // The click prevents accidental recording during normal development.
    ui.startButton.removeEventListener('click', startGame)
    ui.startButton.addEventListener('click', recordDemo, { once: true })
    ui.startButton.querySelector('strong').textContent = 'Record forge run'
    ui.startButton.querySelector('small').textContent = 'Exports an optimized source clip'
}
