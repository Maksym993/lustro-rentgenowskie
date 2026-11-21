// Śledzenie sylwetki, twarzy i dłoni przez MediaPipe. Wszystko liczy się na tym komputerze,
// modele i pliki wasm leżą w public/, więc aplikacja nie potrzebuje sieci.
import { FilesetResolver, FaceLandmarker, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

export class Sledzenie {
  constructor() {
    this.gotowe = false;
    this.czasy = { poza: 0, twarz: 0, dlonie: 0 };
  }

  async start({ ciezkiModel = false } = {}) {
    const zestaw = (this.zestaw = await FilesetResolver.forVisionTasks('/wasm'));
    const baza = (plik) => ({ modelAssetPath: '/modele/' + plik, delegate: 'GPU' });
    this.poza = await this._nowaPoza(ciezkiModel);
    this.ciezki = ciezkiModel;
    this.twarz = await FaceLandmarker.createFromOptions(zestaw, {
      baseOptions: baza('face_landmarker.task'),
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    this.dlonie = await HandLandmarker.createFromOptions(zestaw, {
      baseOptions: baza('hand_landmarker.task'),
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.gotowe = true;
  }

  _nowaPoza(ciezki) {
    return PoseLandmarker.createFromOptions(this.zestaw, {
      baseOptions: { modelAssetPath: '/modele/' + (ciezki ? 'pose_landmarker_heavy.task' : 'pose_landmarker_full.task'), delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }
  // Wymiana modelu sylwetki w trakcie pracy: dokładniejszy (cięższy) lepiej znosi szybki ruch i słabe światło,
  // ale liczy się ok. dwa razy dłużej. Stary model działa, dopóki nowy się nie wczyta.
  async ustawCiezkiModel(ciezki) {
    if (!this.gotowe || this.ciezki === ciezki || this.wymiana) return;
    this.wymiana = true;
    try {
      const nowa = await this._nowaPoza(ciezki);
      const stara = this.poza;
      this.poza = nowa;
      this.ciezki = ciezki;
      stara.close();
    } finally {
      this.wymiana = false;
    }
  }

  // Do pomiarów: sylwetka liczona z pojedynczego obrazu, bez pamięci poprzednich klatek (tryb IMAGE).
  // Porównanie z wynikiem trybu VIDEO pokazuje, ile opóźnienia dokłada wewnętrzne wygładzanie modelu.
  async pozaZObrazu(obraz) {
    if (!this.pozaObraz) {
      const zestaw = await FilesetResolver.forVisionTasks('/wasm');
      this.pozaObraz = await PoseLandmarker.createFromOptions(zestaw, {
        baseOptions: { modelAssetPath: '/modele/pose_landmarker_full.task', delegate: 'GPU' },
        runningMode: 'IMAGE',
        numPoses: 1,
      });
    }
    const r = this.pozaObraz.detect(obraz);
    return r.landmarks && r.landmarks.length ? r.landmarks[0].map((l) => [l.x, l.y, l.z]) : null;
  }

  // Zwraca punkty w układzie obrazu (0..1), bez wygładzania.
  wykryj(obraz, czasMs, co = { poza: true, twarz: true, dlonie: true }) {
    const wyn = { poza: null, twarz: null, dlonie: [] };
    if (!this.gotowe) return wyn;
    let t = performance.now();
    if (co.poza) {
      const r = this.poza.detectForVideo(obraz, czasMs);
      if (r.landmarks && r.landmarks.length) {
        wyn.poza = { p: r.landmarks[0].map((l) => [l.x, l.y, l.z]), w: r.landmarks[0].map((l) => l.visibility ?? 1) };
      }
    }
    this.czasy.poza = performance.now() - t;
    t = performance.now();
    if (co.twarz) {
      const r = this.twarz.detectForVideo(obraz, czasMs);
      if (r.faceLandmarks && r.faceLandmarks.length) {
        const ksz = {};
        if (r.faceBlendshapes && r.faceBlendshapes.length) for (const k of r.faceBlendshapes[0].categories) ksz[k.categoryName] = k.score;
        wyn.twarz = { p: r.faceLandmarks[0].map((l) => [l.x, l.y, l.z]), ksztalty: ksz };
      }
    }
    this.czasy.twarz = performance.now() - t;
    t = performance.now();
    if (co.dlonie) {
      const r = this.dlonie.detectForVideo(obraz, czasMs);
      if (r.landmarks) {
        for (let i = 0; i < r.landmarks.length; i++) {
          const et = r.handedness?.[i]?.[0];
          // MediaPipe zakłada obraz lustrzany, a klatka z kamery lustrzana nie jest, więc etykietę trzeba odwrócić
          const strona = et ? (et.categoryName === 'Left' ? 'P' : 'L') : null;
          wyn.dlonie.push({ p: r.landmarks[i].map((l) => [l.x, l.y, l.z]), strona, pewnosc: et?.score ?? 0 });
        }
      }
    }
    this.czasy.dlonie = performance.now() - t;
    return wyn;
  }
}
