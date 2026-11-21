// Strażnik sylwetki. Gdy w kadrze jest sama dłoń, model sylwetki potrafi „zobaczyć” w niej całe ciało i co kilka klatek
// rysować tułów albo nogi tam, gdzie ich nie ma. Strażnik przepuszcza sylwetkę, gdy potwierdza ją twarz, a bez twarzy
// tylko wtedy, gdy trwa kilka klatek i nie dominuje nad nią wykryta dłoń.
const odl = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sr = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// Rozmiar ciała w pikselach, wyrażony jak szerokość barków, ale odporny na obrót. Gdy ktoś staje bokiem albo
// podskakuje, barki nakładają się na obrazie i sama ich szerokość spada prawie do zera. Dlatego bierzemy największą
// z kilku miar, przeliczonych na szerokość barków: długość tułowia, odległość uszu i nosa od barków, rozstaw bioder.
export function rozmiarCiala(p, w) {
  const barki = sr(p[11], p[12]);
  let r = odl(p[11], p[12]);
  if (w[23] > 0.5 && w[24] > 0.5) r = Math.max(r, odl(p[23], p[24]) * 1.85, odl(barki, sr(p[23], p[24])) * 0.65);
  if (w[7] > 0.5 && w[8] > 0.5) r = Math.max(r, odl(sr(p[7], p[8]), barki) * 1.8);
  if (w[0] > 0.5) r = Math.max(r, odl(p[0], barki) * 1.6);
  return Math.max(1, r);
}

// Czy twarz z modelu twarzy może być twarzą osoby, którą widzi model sylwetki. Zwraca null, gdy sylwetka nie widzi
// głowy i nie ma z czym porównać. Twarz odpada w dwóch przypadkach, każdy potwierdzony dwiema niezależnymi miarami:
// - za duża: ponad dwa razy większa od głowy sylwetki i do tego prawie tak szeroka jak barki (prawdziwa twarz
//   ma ok. 40% szerokości barków),
// - za mała: ponad dwa razy mniejsza od głowy sylwetki i leży poza tą głową (np. twarz z plakatu za plecami).
// Rozmiary biorą większą z szerokości i wysokości, bo przy obrocie głowy szerokość się skraca, a wysokość nie.
export function twarzPasujeDoSylwetki(poza, twarz) {
  const { p, w } = poza;
  if (!(w[0] > 0.6)) return null;
  const rozmiarTwarzy = Math.max(odl(twarz[234], twarz[454]), odl(twarz[10], twarz[152]) * 0.78);
  // odległość oczu od ust to ok. 45% szerokości twarzy
  const rozmiarGlowy = Math.max(odl(p[7], p[8]), odl(sr(p[2], p[5]), sr(p[9], p[10])) * 2.1);
  if (!(rozmiarGlowy > 1) || !(rozmiarTwarzy > 1)) return null;
  const st = rozmiarTwarzy / rozmiarGlowy;
  if (st > 2.2) return !(w[11] > 0.5 && w[12] > 0.5 && rozmiarTwarzy > 0.9 * rozmiarCiala(p, w));
  if (st < 0.45) return odl(twarz[1], p[0]) < rozmiarGlowy;
  return true;
}

// Strażnik stron ciała. Przy szybkim ruchu przodem do kamery model sylwetki potrafi na klatkę albo dwie zamienić
// lewą stronę ciała z prawą: kolana i łokcie zamieniają się miejscami, a barki i biodra zapadają się do środka.
// Taką klatkę poznajemy po tym, że po zamianie stron pasuje do poprzedniej dużo lepiej niż wprost. Prawdziwy obrót
// tyłem przechodzi przez ustawienie bokiem, w którym obie strony leżą blisko siebie, więc tego progu nie przekracza.
// Odrzuconą klatkę bufor wypełnia z sąsiednich i anatomia przechodzi przez nią płynnie.
const PARY_STRON = [[11, 12], [13, 14], [15, 16], [23, 24], [25, 26], [27, 28]];
export class StraznikStron {
  constructor() {
    this.zeruj();
  }
  zeruj() {
    this.wzor = null; // ostatnia przyjęta sylwetka
    this.wiek = 0; // ile klatek temu
    this.odrzucone = 0; // ile klatek z rzędu odrzuconych
  }
  // poza: { p, w } w układzie sceny. Zwraca true, gdy stronom ciała w tej klatce można wierzyć.
  sprawdz(poza) {
    this.wiek++;
    if (!poza) return true;
    const { p, w } = poza;
    if (this.wzor && this.wiek <= 6 && this.odrzucone < 5) {
      let wprost = 0, zamiana = 0, ile = 0;
      for (const [l, r] of PARY_STRON) {
        if (w[l] < 0.5 || w[r] < 0.5 || this.wzor.w[l] < 0.5 || this.wzor.w[r] < 0.5) continue;
        wprost += odl(p[l], this.wzor.p[l]) + odl(p[r], this.wzor.p[r]);
        zamiana += odl(p[l], this.wzor.p[r]) + odl(p[r], this.wzor.p[l]);
        ile++;
      }
      if (ile >= 3 && zamiana < 0.5 * wprost) {
        this.odrzucone++;
        this.razem = (this.razem || 0) + 1; // licznik do pomiarów
        return false;
      }
    }
    // po pięciu odrzuconych klatkach z rzędu przyjmujemy nowy układ: widocznie ktoś naprawdę stanął tyłem
    this.wzor = { p: p.map((x) => [x[0], x[1]]), w: Array.from(w) };
    this.wiek = 0;
    this.odrzucone = 0;
    return true;
  }
}

export class StraznikPozy {
  constructor() {
    this.zeruj();
  }
  zeruj() {
    this.zaufana = false; // sylwetka potwierdzona twarzą i od tej pory ciągła
    this.ciag = 0; // ile klatek z rzędu sylwetka jest wykrywana
    this.przyjete = 0; // ile klatek z rzędu sylwetka przeszła kontrolę
    this.wiekTwarzy = 0; // ile klatek z rzędu twarz przeszła kontrolę
    this.przerwa = 99; // ile klatek temu była ostatnio
    this.srodek = null;
    this.odDuzejDloni = 99; // ile klatek temu dłoń była większa, niż pozwalają proporcje ciała
  }

  // poza: { p, w } albo null, twarz: punkty twarzy albo null, dlonie: [{ p } | null]. Punkty w układzie sceny.
  // Zwraca true, gdy sylwetce można wierzyć.
  // krokCiagu: o ile rośnie licznik ciągłości (na stojącym obrazie nie ma kolejnych klatek, więc liczymy go od razu).
  sprawdz(poza, twarz, dlonie, krokCiagu = 1) {
    const wynik = this._sprawdz(poza, twarz, dlonie, krokCiagu);
    this.przyjete = wynik ? this.przyjete + krokCiagu : 0;
    return wynik;
  }

  // Twarz „widziana” tam, gdzie jej nie ma. Przy całej sylwetce w kadrze model twarzy potrafi na klatkę albo dwie
  // uznać za twarz tors: taka twarz jest kilka razy większa od głowy i rozdmuchuje czaszkę oraz klatkę piersiową.
  // Twarz musi więc pasować do sylwetki, która przeszła kontrolę (sylwetka zgadnięta z dłoni jej nie przechodzi,
  // więc prawdziwej twarzy nie wyrzuci). Twarz, która już przez kilkanaście klatek zgadzała się z sylwetką,
  // przechodzi zawsze, bo wtedy to sylwetka mogła się pomylić.
  // twarz: surowe punkty twarzy w układzie sceny albo null. Wołane przed sprawdz() dla tej samej klatki.
  twarzWiarygodna(poza, twarz, krokCiagu = 1) {
    if (!twarz) {
      this.wiekTwarzy = 0;
      return false;
    }
    const pasuje = poza ? twarzPasujeDoSylwetki(poza, twarz) : null;
    if (pasuje) this.wiekTwarzy += krokCiagu;
    if (pasuje === false && this.przyjete >= 3 && this.wiekTwarzy < 10) {
      this.wiekTwarzy = 0;
      return false;
    }
    return true;
  }

  _sprawdz(poza, twarz, dlonie, krokCiagu) {
    this.odDuzejDloni++;
    if (!poza) {
      this.przerwa++;
      if (this.przerwa > 12) {
        this.zaufana = false;
        this.ciag = 0;
      }
      return false;
    }
    const szer = rozmiarCiala(poza.p, poza.w);
    const srodek = sr(poza.p[11], poza.p[12]);
    // sylwetka wróciła po dłuższej przerwie albo przeskoczyła w inne miejsce: zaufanie trzeba zdobyć od nowa
    if (this.przerwa > 12 || (this.srodek && odl(srodek, this.srodek) > 0.8 * szer)) {
      this.zaufana = false;
      this.ciag = 0;
    }
    this.srodek = srodek;
    this.przerwa = 0;
    this.ciag += krokCiagu;
    // potwierdzenie twarzą: nos z sylwetki leży na twarzy z modelu twarzy
    if (twarz && poza.w[0] > 0.5) {
      const szerTwarzy = odl(twarz[234], twarz[454]) || 1;
      if (odl(poza.p[0], twarz[1]) < 0.6 * szerTwarzy) this.zaufana = true;
    }
    if (this.zaufana) return true;
    let najwieksza = 0;
    for (const d of dlonie) if (d) najwieksza = Math.max(najwieksza, odl(d.p[0], d.p[9]));
    // dłoń prawie tak duża jak całe „ciało” znaczy, że sylwetka została zgadnięta z samej dłoni
    if (najwieksza > 0.75 * szer) this.odDuzejDloni = 0;
    if (this.odDuzejDloni < 15) return false;
    return this.ciag >= 4;
  }
}
