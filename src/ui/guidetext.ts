/**
 * Help → Learn: concise, readable documentation for every part of PhotoPane (Russian and English).
 * Loaded lazily when the Learn window opens.
 */
export interface GuideItem {
  /** title: Russian, English */
  t: [string, string];
  /** what it does and how to use it (paragraphs separated by \n\n) */
  d: [string, string];
  /** keys, shown as a badge */
  k?: string;
}
export interface GuideSection { id: string; t: [string, string]; intro?: [string, string]; items: GuideItem[] }

export const GUIDE: GuideSection[] = [
  {
    id: 'start', t: ['Начало работы', 'Getting started'],
    intro: [
      'Интерфейс PhotoPane устроен привычно: наверху находится главное меню, прямо под ним — параметры выбранного инструмента. Слева собраны сами инструменты, справа расположены панели «Навигатор», «История» и «Слои», а внизу идёт строка состояния с масштабом, размерами документа и короткими подсказками.',
      'PhotoPane uses a familiar layout: the menu bar sits at the top, with the active tool\'s options right below it. Tools are on the left, the Navigator, History, and Layers panels are on the right, and the status bar at the bottom shows the zoom level, document size, and quick tool tips.',
    ],
    items: [
      {
        t: ['Открыть и создать', 'Open and create'], k: 'Ctrl+O, Ctrl+N',
        d: [
          'Чтобы открыть изображение, выберите «Файл → Открыть», перетащите файлы прямо в окно редактора или вставьте картинку из буфера обмена сочетанием Ctrl+V. Редактор поддерживает PNG, JPEG, WebP, GIF, BMP, AVIF и PSD со слоями, масками и редактируемым текстом.\n\nКоманда «Создать» открывает чистый документ с нужными размерами и фоном, а «Создать из буфера обмена» сразу делает новый документ из скопированного изображения.',
          'Open images via File → Open, by dragging files straight into the window, or by pasting from the clipboard with Ctrl+V. PhotoPane supports PNG, JPEG, WebP, GIF, BMP, AVIF, and PSD files with layers, masks, and editable text.\n\nUse New to start with a blank canvas of your chosen size and background, or New from Clipboard to create a document from a copied image.',
        ],
      },
      {
        t: ['Сохранить и экспортировать', 'Save and export'], k: 'Ctrl+S, Ctrl+Shift+S',
        d: [
          '«Сохранить» перезаписывает файл в его исходном формате. Если работа ещё не закончена, лучше сохранить документ в PSD — в нём останутся все слои, маски, стили и редактируемый текст.\n\nКоманда «Экспортировать как» сводит изображение в JPEG, PNG, WebP или PDF. В окне экспорта можно задать размер и качество и сразу увидеть итоговый вес файла; выбранное качество запоминается отдельно для каждого формата.',
          'Save writes changes back to the file in its current format. For work in progress, save as PSD to keep all your layers, masks, layer styles, and editable text intact.\n\nExport As flattens the image to JPEG, PNG, WebP, or PDF. You can adjust the dimensions and quality while seeing the resulting file size right away, and PhotoPane remembers your quality setting separately for each format.',
        ],
      },
      {
        t: ['Масштаб и перемещение', 'Zoom and navigation'], k: 'Ctrl+0, Ctrl+1, Space',
        d: [
          'Приближать и отдалять изображение под курсором удобнее всего колесом мыши с зажатым Ctrl или Alt. Для пошагового масштабирования есть Ctrl+= и Ctrl+−, Ctrl+0 вписывает документ целиком в окно, а Ctrl+1 показывает его в масштабе 100 %.\n\nЕсли зажать пробел, любой инструмент на время превратится в «Руку», чтобы свободно подвинуть холст. Ориентироваться на крупных снимках помогает и панель «Навигатор»: перетаскивайте в ней рамку видимой области или двигайте ползунок масштаба.',
          'Zoom in and out around the cursor by holding Ctrl or Alt while scrolling the mouse wheel. You can also step through zoom levels with Ctrl+= and Ctrl+−, fit the whole image on screen with Ctrl+0, or view it at 100% with Ctrl+1.\n\nHold Space to temporarily switch any tool to the Hand so you can pan around the canvas. On large images, you can also drag the visible frame or adjust the zoom slider in the Navigator panel.',
        ],
      },
      {
        t: ['История', 'History'], k: 'Ctrl+Z, Ctrl+Shift+Z',
        d: [
          'Каждое изменение записывается отдельным шагом в панели «История». Отменить действие можно нажатием Ctrl+Z, вернуть обратно — Ctrl+Shift+Z, а клик по любому шагу в списке сразу перенесёт документ в это состояние. Учтите, что если после отката внести новую правку, все последующие шаги из истории удалятся.',
          'Every edit is recorded as a step in the History panel. Press Ctrl+Z to undo, Ctrl+Shift+Z to redo, or click any step in the list to jump straight back to it. Keep in mind that making a new edit after stepping back discards all the later steps.',
        ],
      },
      {
        t: ['Сравнение (Просмотр → Дублировать)', 'Compare (View → Duplicate)'],
        d: [
          'Делит рабочую область на две половины и открывает справа независимую копию документа со всей его историей. Так удобно откатить одну версию на несколько шагов назад или обработать её иначе и сравнить оба варианта рядом.\n\nМасштаб и положение холста синхронизируются между половинами. Даже если одну из копий увеличить в 2× или 4×, обе стороны будут показываться в одном видимом размере — точка в точку.',
          'Splits the workspace in two and opens an independent copy of your document on the right, complete with its own history. You can step one side back or try a different edit and compare both versions side by side.\n\nZoom and pan stay synced across both panes. Even if you upscale one side by 2× or 4×, PhotoPane matches their on-screen scale so you can compare them point for point.',
        ],
      },
      {
        t: ['Линейки, направляющие и привязка', 'Rulers, guides, and snapping'], k: 'Ctrl+R, Ctrl+;',
        d: [
          'Сочетание Ctrl+R включает линейки по краям холста; чтобы добавить направляющую, просто вытяните её мышкой с линейки. Показать или скрыть направляющие можно клавишами Ctrl+;, а Ctrl+Shift+; включает привязку, с которой слои, выделения и рамки аккуратно прилипают к краям, центру и направляющим.',
          'Press Ctrl+R to toggle rulers along the edges of the canvas, and drag out from either ruler to place a guide. Press Ctrl+; to hide or show guides, and Ctrl+Shift+; to toggle snapping so layers, selections, and frames align cleanly to edges, centers, and guides.',
        ],
      },
      {
        t: ['Основной и фоновый цвет', 'Foreground and background color'], k: 'X, D',
        d: [
          'Оба цвета отображаются двумя квадратами внизу панели инструментов. Основным цветом рисуют кисть, заливка и текст, а фоновым работают ластик на слое с закреплённой прозрачностью и расширение холста. Клавиша X меняет цвета местами, D сбрасывает их к чёрному и белому, а клик по любому квадрату открывает палитру выбора цвета.',
          'Your active colors appear as two swatches at the bottom of the toolbar. The Brush, Paint Bucket, and Type tools use the foreground color, while canvas extension and the Eraser (on transparency-locked layers) use the background color. Press X to swap them, D to reset to black and white, or click either swatch to open the Color Picker.',
        ],
      },
      {
        t: ['Окна и панели', 'Windows and panels'],
        d: [
          'Окна коррекций и фильтров открываются рядом с изображением и сразу показывают изменения на холсте. Их можно свободно перетаскивать по экрану — редактор запомнит удобное для вас место. Панели справа сворачиваются по клику на заголовок, а ширину самой колонки можно подтянуть за границу.\n\nЕсли окна разъехались, команда «Просмотр → Сбросить расположение окон и панелей» вернёт всё в исходный вид. Язык интерфейса переключается кнопкой RU/EN в правом верхнем углу.',
          'Adjustment and filter windows open beside the canvas and preview changes live. Drag them wherever they feel most comfortable — PhotoPane remembers where you put them. You can collapse panels on the right by clicking their titles and resize the sidebar by dragging its edge.\n\nIf things get cluttered, choose View → Reset Window and Panel Layout to restore the defaults. Use the RU/EN button in the top-right corner to switch the interface language.',
        ],
      },
    ],
  },
  {
    id: 'tools', t: ['Инструменты', 'Tools'],
    intro: [
      'Настройки выбранного инструмента всегда отображаются в верхней панели под главным меню. При работе с кистями те же параметры можно быстро открыть прямо на холсте правым кликом мыши, а клавиши [ и ] удобно меняют размер кисти на лету.',
      'Options for the active tool appear in the bar right below the menus. When using brush tools, you can also right-click anywhere on the canvas to adjust settings on the spot, and press [ or ] to change the brush size.',
    ],
    items: [
      {
        t: ['Перемещение', 'Move'], k: 'V',
        d: [
          'Перетаскивает активный слой или сразу несколько выделенных слоёв. Чтобы быстро выбрать нужный слой прямо на холсте, кликните по нему с зажатым Ctrl или включите флажок «Автовыбор слоя».\n\nСтрелки на клавиатуре сдвигают слой на 1 пиксель, а вместе с Shift — на 10. В верхней панели также есть кнопки выравнивания по краям и центру холста (или выделения), поворота и отражения.',
          'Moves the active layer or all currently selected layers. To pick a layer straight from the canvas, hold Ctrl while clicking it, or turn on Auto-Select to do so automatically.\n\nUse the arrow keys to nudge a layer by 1 px, or hold Shift to move in 10 px steps. The options bar also includes quick buttons to align, rotate, and flip the layer relative to the canvas or active selection.',
        ],
      },
      {
        t: ['Выделение', 'Marquee'], k: 'M',
        d: [
          'Выделяет прямоугольную или эллиптическую область. Если во время рисования зажать Shift, получится ровный квадрат или круг, а с Alt область будет строиться из центра. Параметр «Растушёвка» делает границу выделения мягкой.\n\nВ панели параметров можно переключать режим выделения: новое, добавление (Shift), вычитание (Alt) и пересечение (Shift+Alt). Готовый контур можно аккуратно подровнять стрелками.',
          'Selects a rectangular or elliptical area. Hold Shift while dragging to constrain the shape to a square or circle, and hold Alt to draw outward from the center. Set a Feather value to soften the selection edge.\n\nChoose how new selections combine in the options bar — new, add (Shift), subtract (Alt), or intersect (Shift+Alt) — and use the arrow keys to nudge the selection outline.',
        ],
      },
      {
        t: ['Лассо', 'Lasso'], k: 'L',
        d: [
          'Выделяет области произвольной формы и работает в трёх режимах. Обычным лассо можно обвести нужный участок от руки, удерживая кнопку мыши. Прямолинейное строит контур из отрезков по кликам, а с зажатым Shift выравнивает линии с шагом 45°. Магнитное само находит границы: кликните на краю объекта и ведите курсор вдоль него — линия будет притягиваться к контрастному переходу.\n\nЕсли в прямолинейном или магнитном режиме вы промахнулись с точкой, начинать заново не придётся: зажмите Ctrl и перетащите любую уже поставленную точку на нужное место. В магнитном режиме соседние участки контура при этом сразу перестроятся вдоль границы. Чтобы замкнуть выделение, нажмите Enter, сделайте двойной клик или кликните по первой точке. Backspace удаляет последнюю точку, а Esc отменяет начатый контур.',
          'Selects freeform areas in three modes. With the freehand lasso, hold down the mouse button and trace around the area you want. The polygonal lasso connects clicks with straight segments, and holding Shift snaps them to 45° increments. The magnetic lasso follows edges for you: click on the border of an object and guide the cursor along it — the line will automatically snap to the strongest contrast.\n\nIf you misplace a point in polygonal or magnetic mode, you don\'t have to start over: hold Ctrl and drag any existing point into place, and in magnetic mode the adjacent segments will re-snap to the edge on their own. To close the selection, press Enter, double-click, or click back on the starting point. Backspace removes the last point, and Esc cancels the outline.',
        ],
      },
      {
        t: ['Волшебная палочка', 'Magic Wand'], k: 'W',
        d: [
          'Одним кликом выделяет область близких по цвету пикселей. «Допуск» определяет, насколько сильно оттенки могут отличаться от выбранной точки. Если включён флажок «Смежные пиксели», выделятся только соприкасающиеся участки; если снять его — совпадения найдутся по всему изображению. Флажок «Образец со всех слоёв» заставляет инструмент учитывать всю видимую картинку, а не только активный слой.',
          'Selects an area of similar color with a single click. Tolerance controls how wide a range of shades gets included. Turn on Contiguous to limit the selection to connected pixels, or uncheck it to pick up matching colors across the entire image. Enable Sample All Layers to evaluate the visible composite rather than just the active layer.',
        ],
      },
      {
        t: ['Кадрирование', 'Crop'], k: 'C',
        d: [
          'Обрезает или расширяет изображение с помощью рамки и сетки третей. В списке пропорций можно выбрать свободное кадрирование, исходное соотношение сторон, популярные форматы, точный размер в пикселях (итог автоматически подгонится под него) или сохранить собственные наборы.\n\nРамку можно вытянуть за пределы холста — новое пространство станет прозрачным, зальётся фоновым цветом, заполнится с учётом содержимого прямо на вашем компьютере или дорисуется с помощью ИИ. Если снять галочку «Удалить отсечённые пиксели», обрезанные края слоёв сохранятся за пределами кадра. Enter применяет кадрирование, Esc убирает рамку, а стрелки сдвигают её.',
          'Trims or expands the canvas using a crop frame with a rule-of-thirds grid. From the ratio menu, choose freeform cropping, the original aspect ratio, standard presets, exact pixel dimensions (which scale the result to match), or save custom presets of your own.\n\nYou can also drag the frame past the canvas edges and fill the new space with transparency, the background color, local content-aware fill, or AI generative fill. Uncheck Delete Cropped Pixels if you want to keep cut-off layer areas intact outside the frame. Press Enter to apply, Esc to clear the frame, and use the arrow keys to nudge it.',
        ],
      },
      {
        t: ['Кадрирование перспективы', 'Perspective Crop'], k: 'C',
        d: [
          'Выравнивает объекты, снятые под углом — например, страницу документа, картину на стене или экран. Перетащите четыре угла рамки на углы объекта и нажмите Enter, чтобы развернуть его в ровный прямоугольник.',
          'Straightens subjects photographed at an angle, such as documents, paintings, or screens. Drag the four corner handles onto the corners of the object and press Enter to flatten it into a clean rectangle.',
        ],
      },
      {
        t: ['Пипетка', 'Eyedropper'], k: 'I',
        d: [
          'Берёт цвет прямо с изображения: обычный клик задаёт основной цвет, а Alt+клик — фоновый. В параметрах можно выбрать, считывать ли одну точку или усреднять область 3×3 или 5×5 пикселей, а также брать образец со всех видимых слоёв. Во время рисования кистью пипетка всегда под рукой — достаточно зажать Alt.',
          'Samples a color directly from the canvas: click to set the foreground color, or Alt+click to set the background color. In the options bar, choose between a single point or a 3×3 or 5×5 average, and decide whether to sample all visible layers. When using a brush, hold Alt anytime to sample a color on the fly.',
        ],
      },
      {
        t: ['Точечная восстанавливающая кисть', 'Spot Healing Brush'], k: 'J',
        d: [
          'Быстро убирает пятна, пылинки, несовершенства кожи и небольшие лишние детали. Просто закрасьте дефект: как только вы отпустите кнопку мыши, область заполнится подходящей текстурой из окружения и аккуратно подстроится по цвету. Лучше всего работает кисть чуть крупнее самого дефекта.',
          'Quickly removes dust, blemishes, spots, and small distractions. Paint over the flaw and release the mouse button — PhotoPane fills the area with matching nearby texture and blends the color seamlessly. For the cleanest results, pick a brush slightly larger than the spot.',
        ],
      },
      {
        t: ['Кисть', 'Brush'], k: 'B',
        d: [
          'Рисует основным цветом. Вы можете настроить размер ([ и ]), жёсткость краёв (Shift+[ и Shift+]), общую непрозрачность мазка и нажим — то есть сколько краски ложится за один проход. Для графического планшета есть опция «Нажим пера влияет на размер». Чтобы провести ровную линию от последней точки, кликните с зажатым Shift, а Alt временно включит пипетку.',
          'Paints with the foreground color. Adjust the size ([ and ]), edge hardness (Shift+[ and Shift+]), overall stroke opacity, and flow — how much paint builds up with each pass. If you use a drawing tablet, turn on Pen Pressure Controls Size. Hold Shift and click to draw a straight line from the last point, or hold Alt to sample a color.',
        ],
      },
      {
        t: ['Замена цвета', 'Color Replacement'], k: 'B',
        d: [
          'Перекрашивает выбранный цвет под кистью в основной, сохраняя объём и светотень — удобно, чтобы изменить цвет одежды или глаз, не задевая всё вокруг. «Допуск» задаёт, насколько близкие оттенки попадут под замену, а режим образца определяет, брать ли исходный цвет непрерывно под курсором или зафиксировать его один раз в начале мазка.',
          'Recolors matching shades under the brush to your foreground color while preserving lighting and shading — great for changing the color of clothing or eyes without affecting surrounding areas. Tolerance controls how wide a range of shades gets replaced, and the sampling mode chooses whether to keep picking up colors continuously or lock onto the color where your stroke began.',
        ],
      },
      {
        t: ['Штамп', 'Clone Stamp'], k: 'S',
        d: [
          'Копирует фрагмент изображения из одного места в другое. Сначала кликните с зажатым Alt, чтобы указать источник, а затем закрашивайте нужную область. Флажок «Выравн.» заставляет источник смещаться вместе с кистью от мазка к мазку, «Образец со всех слоёв» берёт текстуру со всей видимой картинки, а «Показывать источник» выводит прямо под курсором предпросмотр копируемого участка.',
          'Copies pixels from one part of the image to another. Start by Alt+clicking to set your source point, then paint where you want to duplicate it. Aligned keeps the source moving relative to your cursor across strokes, Sample All Layers pulls from the entire visible image, and Show Source previews the copied pixels right inside your brush.',
        ],
      },
      {
        t: ['Ластик', 'Eraser'], k: 'E',
        d: [
          'Стирает пиксели активного слоя до прозрачности, а на маске слоя работает так же, как чёрная кисть — скрывает выбранные участки. Параметры размера, жёсткости и непрозрачности устроены так же, как у кисти. Если у слоя закреплены прозрачные пиксели, ластик не стирает их, а закрашивает фоновым цветом.',
          'Erases pixels on the active layer to transparency — or hides areas when painting on a layer mask. Its size, hardness, and opacity controls work just like the Brush tool. If a layer has transparent pixels locked, the Eraser paints with the background color instead.',
        ],
      },
      {
        t: ['Градиент', 'Gradient'], k: 'G',
        d: [
          'Создаёт плавный линейный или радиальный переход от основного цвета к фоновому либо к прозрачности. Протяните линию на холсте, чтобы задать направление и длину перехода; зажатый Shift выравнивает угол с шагом 45°, а галочка «Инверсия» меняет цвета местами. Если активно выделение, градиент ложится только внутри него.',
          'Creates a smooth linear or radial transition from the foreground color to the background color or to transparency. Drag across the canvas to set the direction and length of the blend — hold Shift to snap to 45° angles, or check Reverse to flip the colors. When a selection is active, the gradient stays inside it.',
        ],
      },
      {
        t: ['Заливка', 'Paint Bucket'], k: 'G',
        d: [
          'Заполняет область близких по цвету пикселей основным цветом. Параметры «Допуск», «Сглаживание», «Смежные пиксели» и «Образец со всех слоёв» работают точно так же, как у «Волшебной палочки».',
          'Fills an area of similar colors with the foreground color. Its Tolerance, Anti-alias, Contiguous, and Sample All Layers options work the same way as the Magic Wand.',
        ],
      },
      {
        t: ['Размытие, резкость и палец', 'Blur, Sharpen, and Smudge'], k: 'R',
        d: [
          'Три кисти для локальной доработки: «Размытие» мягко сглаживает детали, «Резкость» подчёркивает контуры, а «Палец» растягивает и смешивает пиксели вдоль движения курсора. Ползунок «Интенсивность» задаёт силу одного прохода, а повторные мазки постепенно усиливают эффект.',
          'Three brushes for local touch-ups: Blur softens details, Sharpen accentuates edges, and Smudge pushes and blends pixels along your stroke. Strength controls how much each pass changes the image, and going over an area again builds up the effect.',
        ],
      },
      {
        t: ['Осветлитель и затемнитель', 'Dodge and Burn'], k: 'O',
        d: [
          'Локально осветляют или затемняют отдельные участки снимка, как при классической фотопечати. Выберите в «Диапазоне» тени, средние тона или света, чтобы воздействовать только на нужную часть яркости, а «Экспонирование» определит силу эффекта за один проход.',
          'Selectively lighten or darken parts of a photo, inspired by traditional darkroom techniques. Pick Shadows, Midtones, or Highlights under Range to target specific brightness levels, and use Exposure to control the strength of each pass.',
        ],
      },
      {
        t: ['Текст', 'Type'], k: 'T',
        d: [
          'Кликните на холсте, чтобы набрать строку текста, или протяните рамку для абзаца с переносом строк. В панели параметров доступны системные шрифты и коллекция Google Fonts с поддержкой кириллицы, а также начертание, размер, цвет, курсив, подчёркивание, зачёркивание, выравнивание, интерлиньяж и межбуквенный интервал.\n\nТекст остаётся редактируемым слоем: чтобы внести правки позже, просто кликните по нему инструментом «Текст». Завершить ввод можно клавишами Esc или Ctrl+Enter.',
          'Click the canvas to add a line of text, or drag out a frame for a wrapping paragraph. The options bar gives you access to system fonts and Google Fonts, along with weight, size, color, italic, underline, strikethrough, alignment, leading, and tracking.\n\nText remains an editable layer — click it again with the Type tool anytime to make changes. Press Esc or Ctrl+Enter when you\'re finished.',
        ],
      },
      {
        t: ['Фигура', 'Shape'], k: 'U',
        d: [
          'Рисует на новом слое прямоугольник (при желании со скруглёнными углами), эллипс, треугольник или линию с настраиваемой заливкой и обводкой. Во время рисования Shift сохраняет правильные пропорции, а Alt строит фигуру от центра.',
          'Draws a rectangle (with optional rounded corners), ellipse, triangle, or line on a new layer, complete with customizable fill and stroke. Hold Shift to keep proportions even, and hold Alt to draw from the center.',
        ],
      },
      {
        t: ['Рука', 'Hand'], k: 'H',
        d: [
          'Позволяет свободно перетаскивать холст по окну, когда изображение увеличено. Двойной клик по холсту этим инструментом вписывает картинку целиком в экран. В любой момент «Руку» можно временно включить, просто зажав пробел.',
          'Pans around a zoomed-in canvas. Double-click the canvas with the Hand tool to fit the entire image on screen. You can also access it temporarily from any tool by holding Space.',
        ],
      },
    ],
  },
  {
    id: 'selection', t: ['Выделение', 'Selection'],
    intro: [
      'Активное выделение ограничивает область работы кистей, заливок, коррекций и фильтров. Перечисленные ниже команды доступны по правому клику на холсте (когда выбран инструмент выделения) и через горячие клавиши.',
      'An active selection limits where brushes, fills, adjustments, and filters take effect. You can reach the commands below from the right-click menu on the canvas (with a selection tool active) or with their keyboard shortcuts.',
    ],
    items: [
      {
        t: ['Всё, отменить, снова и инверсия', 'All, deselect, reselect, and inverse'], k: 'Ctrl+A, Ctrl+D, Ctrl+Shift+I',
        d: [
          'Ctrl+A выделяет весь холст, Ctrl+D снимает выделение, а Ctrl+Shift+D возвращает последнее снятое выделение. Сочетание Ctrl+Shift+I инвертирует область, выделяя всё, что раньше оставалось снаружи.',
          'Press Ctrl+A to select the entire canvas, Ctrl+D to deselect, or Ctrl+Shift+D to bring back your last selection. Ctrl+Shift+I inverts the selection so everything outside it becomes selected instead.',
        ],
      },
      {
        t: ['Растушёвка, расширить, сжать и сгладить', 'Feather, expand, contract, and smooth'], k: 'Shift+F6',
        d: [
          'Эти команды помогают аккуратно доработать границу выделения. «Растушёвка» делает край мягким, «Расширить» и «Сжать» сдвигают границу наружу или внутрь на заданное число пикселей, а «Сгладить» убирает резкие зубцы и мелкие неровности.',
          'Fine-tune the border of an active selection: Feather softens the edge, Expand and Contract grow or shrink the boundary by a set number of pixels, and Smooth rounds off jagged corners and tiny bumps.',
        ],
      },
      {
        t: ['Загрузить пиксели слоя', 'Load layer pixels'],
        d: [
          'Создаёт выделение точно по непрозрачным пикселям текущего слоя. Того же результата можно добиться быстрее — кликнув с зажатым Ctrl по миниатюре слоя в панели «Слои».',
          'Creates a selection matching the opaque pixels of the current layer. You can also do this in one click by holding Ctrl and clicking the layer\'s thumbnail in the Layers panel.',
        ],
      },
      {
        t: ['Трансформировать выделенную область', 'Transform selection'],
        d: [
          'Позволяет масштабировать, поворачивать и искажать сам контур выделения, не изменяя пиксели на слое.',
          'Scales, rotates, and distorts the selection outline itself without modifying any pixels on the layer.',
        ],
      },
      {
        t: ['Новый слой копированием и вырезанием', 'Layer via copy and via cut'], k: 'Ctrl+J, Ctrl+Shift+J',
        d: [
          'Переносит выделенный фрагмент на новый отдельный слой — копируя его (Ctrl+J) или вырезая из исходного слоя (Ctrl+Shift+J).',
          'Moves the selected area onto its own new layer — either by copying it (Ctrl+J) or cutting it out of the original layer (Ctrl+Shift+J).',
        ],
      },
      {
        t: ['Выполнить заливку и обводку', 'Fill and stroke'], k: 'Shift+F5',
        d: [
          'Команда «Выполнить заливку» заполняет выделение выбранным цветом, белым, чёрным, 50 % серого или в режиме «С учётом содержимого» — в этом случае редактор сам достраивает область из окружающей текстуры, что позволяет легко убрать лишний объект. Для быстрой заливки без окна есть Alt+Backspace (основным цветом) и Ctrl+Backspace (фоновым).\n\n«Выполнить обводку» обводит контур выделения линией нужной толщины и цвета — внутри, по центру или снаружи границы.',
          'Fill lets you fill a selection with a color, white, black, 50% gray, or Content-Aware fill — which rebuilds the area from surrounding textures to cleanly remove unwanted objects. For instant fills without opening the dialog, press Alt+Backspace (foreground color) or Ctrl+Backspace (background color).\n\nStroke draws a border along the selection outline at your chosen width and color — inside, centered on, or outside the edge.',
        ],
      },
      {
        t: ['Выделить объект (ИИ)', 'Select Subject (AI)'],
        d: [
          'Автоматически находит главный объект на снимке — человека, животное или вещь — и выделяет его. Для работы нужен API-ключ Stability AI.',
          'Automatically detects the main subject of a photo — a person, animal, or object — and creates a selection around it. Requires a Stability AI API key.',
        ],
      },
    ],
  },
  {
    id: 'layers', t: ['Слои', 'Layers'],
    intro: [
      'Каждый слой — это отдельный прозрачный лист поверх нижних, поэтому элементы композиции можно править независимо друг от друга. Кнопки внизу панели открывают стиль слоя, добавляют маску, создают группу, новый слой или дубликат и удаляют выбранное. Полный список действий со слоем всегда доступен по правому клику.',
      'Each layer sits like a transparent sheet stacked on top of the ones below it, letting you edit parts of an image independently. The buttons at the bottom of the Layers panel open Layer Style, add a mask, create a group or new layer, duplicate, and delete. Right-click any layer to see all of its commands.',
    ],
    items: [
      {
        t: ['Порядок и видимость', 'Order and visibility'], k: 'Ctrl+[, Ctrl+]',
        d: [
          'Чтобы изменить порядок слоёв, перетащите их мышкой в списке или используйте сочетания Ctrl+[ и Ctrl+] (с зажатым Shift слой сразу переносится в самый низ или наверх). Значок глаза слева временно скрывает слой, а двойной клик по названию позволяет переименовать его. Выбрать сразу несколько слоёв можно с помощью Ctrl+клик или Shift+клик.',
          'Drag layers in the list to reorder them, or press Ctrl+[ and Ctrl+] to move a layer down and up (add Shift to jump all the way to the bottom or top). Click the eye icon to toggle visibility, double-click a name to rename it, and use Ctrl+click or Shift+click to select multiple layers.',
        ],
      },
      {
        t: ['Режим наложения, непрозрачность и закрепление', 'Blend mode, opacity, and lock'], k: '/',
        d: [
          'Эти элементы находятся над списком слоёв. Режим наложения определяет, как слой смешивается с тем, что лежит под ним: «Умножение» затемняет и убирает белый цвет, «Экран» осветляет и убирает чёрный, «Перекрытие» и «Мягкий свет» усиливают контраст, а «Цветность» и «Яркость» переносят только цвет или только светотень.\n\nПолзунок «Непрозрачность» регулирует видимость слоя от 0 до 100 %. Значок замка закрепляет прозрачные пиксели — после этого кисти и заливки будут действовать только на уже закрашенных участках слоя.',
          'These controls sit right above the layer list. Blend modes decide how a layer mixes with what\'s underneath: Multiply darkens and drops out white, Screen lightens and drops out black, Overlay and Soft Light boost contrast, and Color and Luminosity apply only the layer\'s color or brightness.\n\nOpacity controls how solid the layer appears from 0% to 100%. The lock icon locks transparent pixels so brushes and fills only affect areas that already have pixels.',
        ],
      },
      {
        t: ['Маска слоя', 'Layer mask'],
        d: [
          'Позволяет прятать части слоя, не стирая их безвозвратно: чёрный цвет на маске скрывает изображение, белый показывает, а оттенки серого делают его полупрозрачным. Нажмите кнопку маски внизу панели, чтобы добавить её — если в этот момент есть выделение, маска сразу создастся по нему.\n\nКлик по миниатюре маски переключает рисование на неё, а Shift+клик временно отключает маску. Остальные команды — показать или скрыть всё, применить или удалить маску — собраны в контекстном меню слоя.',
          'Hides parts of a layer without permanently erasing pixels: painting black on a mask conceals the layer, white reveals it, and shades of gray make it semi-transparent. Click the mask button at the bottom of the panel to add one — if you have an active selection, the mask automatically matches it.\n\nClick the mask thumbnail to paint on it, or Shift+click to temporarily disable it. Right-click the layer for additional options to reveal all, hide all, apply, or delete the mask.',
        ],
      },
      {
        t: ['Обтравочная маска', 'Clipping mask'], k: 'Ctrl+Alt+G',
        d: [
          'Ограничивает видимость слоя формой слоя, лежащего прямо под ним. Так удобно наложить текстуру, тень или цвет строго внутри букв или вырезанного объекта, не создавая отдельную маску.',
          'Clips a layer so it only appears where the layer directly beneath it has opaque pixels. It\'s an easy way to apply a texture, highlight, or color neatly inside text or a cutout shape.',
        ],
      },
      {
        t: ['Группы', 'Groups'], k: 'Ctrl+G, Ctrl+Shift+G',
        d: [
          'Объединяют связанные слои в одну папку, чтобы вместе их скрывать, передвигать, менять им общую непрозрачность или накладывать одну маску на всех. В режиме наложения «Пропустить» слои внутри группы взаимодействуют с нижними слоями так, будто папки нет.',
          'Organizes related layers into a folder that you can hide, move, mask, or adjust opacity for all at once. With the default Pass Through blend mode, layers inside the group blend with layers below it as if they weren\'t grouped.',
        ],
      },
      {
        t: ['Стиль слоя', 'Layer style'],
        d: [
          'Неразрушающие эффекты, которые автоматически подстраиваются под любые изменения на слое: тень, обводка, тиснение, наложение цвета и градиента, а также параметры наложения. Клик по значку fx в строке слоя скрывает эффекты, а двойной клик открывает окно их настройки.',
          'Live effects that automatically adapt whenever you edit the layer: drop shadow, stroke, bevel and emboss, color overlay, gradient overlay, and blending options. Click the fx badge on a layer to toggle its effects, or double-click to edit them.',
        ],
      },
      {
        t: ['Свободное трансформирование', 'Free transform'], k: 'Ctrl+T',
        d: [
          'Открывает вокруг слоя рамку трансформации. Потяните за углы, чтобы изменить размер (Shift отключает сохранение пропорций, Alt масштабирует от центра), или за область снаружи рамки, чтобы повернуть слой. Удерживая Ctrl, можно свободно искажать отдельные углы, а Ctrl+Alt+Shift меняет перспективу. Enter применяет трансформацию, Esc отменяет её.',
          'Places a transform box around the layer. Drag the corners to scale (hold Shift for free proportions, Alt to scale from the center), or drag outside the box to rotate. Hold Ctrl while dragging a corner to distort, or Ctrl+Alt+Shift for perspective. Press Enter to apply or Esc to cancel.',
        ],
      },
      {
        t: ['Объединение и сведение', 'Merging and flattening'], k: 'Ctrl+E, Ctrl+Shift+E',
        d: [
          '«Объединить с предыдущим» сливает активный слой с тем, что находится под ним, а «Объединить видимые» соединяет все включённые слои в один. Если нужно сохранить исходную структуру, используйте «Свести видимые в новый слой» (Ctrl+Alt+Shift+E) — она создаст объединённую копию поверх остальных. «Выполнить сведение» объединяет весь документ в один фоновый слой.',
          'Merge Down combines the active layer with the one below it, and Merge Visible joins all visible layers into one. To keep your original layers intact, use Stamp Visible (Ctrl+Alt+Shift+E) to place a flattened copy on top of the stack. Flatten Image collapses the entire document into a single background layer.',
        ],
      },
      {
        t: ['Растрировать', 'Rasterize'],
        d: [
          'Превращает текстовый слой в обычный растровый — это нужно, если вы хотите рисовать по буквам кистью или применять к ним фильтры. После растрирования отредактировать текст как буквы уже нельзя.',
          'Converts a text layer into regular pixels so you can paint on it or run filters. Once rasterized, the text can no longer be edited as live type.',
        ],
      },
    ],
  },
  {
    id: 'adjust', t: ['Коррекция', 'Adjustments'],
    intro: [
      'Все инструменты коррекции находятся в меню «Изображение». Их окна открываются рядом с холстом и сразу показывают результат на активном слое (в пределах выделения, если оно есть). Флажок «До / после» включает разделитель для сравнения с исходником, а удачные настройки можно сохранять как пресеты.\n\nНесколько окон коррекций и фильтров можно держать открытыми одновременно — они выстроятся в живую цепочку и применятся вместе.',
      'All adjustments live in the Image menu. Their windows open beside the canvas and preview changes live on the active layer (or inside an active selection). Toggle Before / After to compare against the original, and save favorite slider combinations as presets.\n\nYou can even keep multiple adjustment and filter windows open at the same time — they stack into a live chain and combine as you tweak them.',
    ],
    items: [
      {
        t: ['Коррекция', 'Adjust'], k: 'Ctrl+U',
        d: [
          'Главное окно для работы со светом и цветом. В блоке «Свет» настраиваются яркость, контраст, светлые участки, тени (помогают вытянуть пересветы и тёмные провалы), а также точки белого и чёрного. В блоке «Цвет» собраны насыщенность, сочность (работает бережнее к уже ярким цветам и оттенкам кожи), температура, оттенок, оттенок кожи и цветовой тон.\n\nНиже находятся «Детали» — резкость, чёткость (локальный контраст) и зернистость — и настройки виньетки: сила, средняя точка, округлость и растушёвка. Кнопка «Авто» быстро подбирает базовые значения, а пресеты переключаются в верхней панели параметров.',
          'Your all-in-one window for fixing light and color. Under Light, adjust brightness, contrast, highlights, and shadows (great for recovering blown-out brights or deep shadows), plus white and black points. Under Color, tweak saturation, vibrance (which protects skin tones and already rich colors), temperature, tint, skin tone, and hue.\n\nBelow that, Detail covers sharpness, clarity (local contrast), and grain, while Vignette controls amount, midpoint, roundness, and feather. Click Auto for a quick starting point, or save and apply presets from the options bar.',
        ],
      },
      {
        t: ['Уровни', 'Levels'], k: 'Ctrl+L',
        d: [
          'Показывает гистограмму яркости с ползунками чёрного, серого и белого на входе и диапазоном на выходе — для всего RGB или каждого канала по отдельности. Чтобы быстро вернуть блёклому снимку контраст, просто подтяните крайние ползунки к краям гистограммы.',
          'Displays a brightness histogram with black, midtone, and white input sliders plus an output range, for RGB as a whole or individual color channels. Pull the outer sliders inward to the edges of the histogram to quickly restore contrast to a flat photo.',
        ],
      },
      {
        t: ['Кривые', 'Curves'], k: 'Ctrl+M',
        d: [
          'Тонкая настройка яркости и контраста для RGB или каждого канала. Клик по линии добавляет контрольную точку, перетаскивание меняет форму кривой, а если вытянуть точку за пределы графика, она удалится. Классическая S-образная кривая аккуратно усиливает контраст.',
          'Gives you precise tonal control over RGB or individual channels. Click the line to add a control point, drag to shape the curve, or drag a point off the graph to remove it. A subtle S-curve is a classic way to add punch and contrast.',
        ],
      },
      {
        t: ['HSL-микшер', 'HSL Mixer'],
        d: [
          'Позволяет отдельно менять тон, насыщенность и яркость восьми цветовых диапазонов — от красного до пурпурного. Так можно сделать небо глубже или приглушить кричащую зелень, не затрагивая остальные цвета на снимке.',
          'Adjusts hue, saturation, and luminance independently across eight color ranges, from reds to magentas. Deepen a blue sky or tone down bright greens without shifting the rest of your photo.',
        ],
      },
      {
        t: ['Тонирование', 'Toning'],
        d: [
          'Раздельно окрашивает светлые участки и тени в выбранные оттенки, задавая тон и насыщенность для каждой области. Ползунок «Баланс» смещает границу перехода между ними.',
          'Tints highlights and shadows with separate colors using dedicated hue and saturation sliders. Use Balance to shift where the transition between shadows and highlights sits.',
        ],
      },
      {
        t: ['Быстрые команды', 'Quick commands'], k: 'Ctrl+I, Ctrl+Shift+U',
        d: [
          'Если нужно сработать мгновенно без открытия окна настроек, Ctrl+I сразу инвертирует цвета слоя, а Ctrl+Shift+U обесцвечивает его на 100 %.',
          'When you want an instant result without opening a window, press Ctrl+I to invert the layer\'s colors or Ctrl+Shift+U to desaturate it completely.',
        ],
      },
    ],
  },
  {
    id: 'filters', t: ['Фильтры', 'Filters'],
    intro: [
      'Все фильтры собраны в меню «Фильтр». Они сразу показывают предпросмотр на активном слое (или внутри выделения) и поддерживают сравнение «До / после». Флажок «Сохранять прозрачность» не позволяет размытию и другим эффектам выходить за границы непрозрачных областей.',
      'All filters live in the Filter menu. Each previews live on the active layer (or inside your selection) and includes a Before / After toggle. Check Preserve Transparency to keep blur and effects from bleeding into transparent areas.',
    ],
    items: [
      {
        t: ['Размытие по Гауссу', 'Gaussian Blur'],
        d: [
          'Создаёт мягкое равномерное размытие по всей области. Чем больше радиус, тем сильнее смягчается изображение.',
          'Creates a smooth, even blur across the image. Increase Radius for a stronger softening effect.',
        ],
      },
      {
        t: ['Размытие в движении', 'Motion Blur'],
        d: [
          'Имитирует смаз от быстрого движения в выбранном направлении — достаточно задать угол и расстояние.',
          'Simulates the streak of a fast-moving subject along a set angle and distance.',
        ],
      },
      {
        t: ['Радиальное размытие', 'Radial Blur'],
        d: [
          'Размывает изображение лучами от выбранного центра (эффект наезда) или по кругу (вращение). Положение центра можно смещать по X и Y.',
          'Blurs outward in rays from a focal point (Zoom) or circularly around it (Spin). You can place the center anywhere using the X and Y sliders.',
        ],
      },
      {
        t: ['Размытие по поверхности', 'Surface Blur'],
        d: [
          'Деликатно сглаживает ровные поверхности вроде кожи или неба, но оставляет чёткими контуры. Параметр «Порог» определяет, какие перепады яркости считать границей.',
          'Smooths flat areas like skin or sky while keeping edges sharp. Threshold controls how strong a contrast step needs to be before it is preserved as an edge.',
        ],
      },
      {
        t: ['Размытие поля', 'Field Blur'],
        d: [
          'Позволяет расставить прямо на снимке булавки и задать каждой свою силу размытия. Клик по холсту ставит новую булавку, кольцо вокруг неё меняет размытие, а Delete удаляет выбранную. Ползунок «Блики боке» превращает яркие огни в мягкие световые кружки. Нажмите Enter, чтобы применить результат.',
          'Lets you drop pins directly onto the photo and give each area its own blur strength. Click to add a pin, drag the ring around it to dial in the blur, and press Delete to remove the active pin. Turn up Bokeh Highlights to bloom bright spots into soft circles, then press Enter to apply.',
        ],
      },
      {
        t: ['Размытие диафрагмы', 'Iris Blur'],
        d: [
          'Оставляет резким выбранный эллипс и плавно размывает всё вокруг него. Внешние точки меняют размер эллипса, внутренние — ширину плавного перехода, центральная точка сдвигает область фокуса, а кольцо регулирует силу размытия.',
          'Keeps an elliptical area in focus while softly blurring everything around it. Drag the outer handles to resize the ellipse, the inner handles to shape the transition, the center to reposition it, and the ring to adjust blur strength.',
        ],
      },
      {
        t: ['Наклон-смещение', 'Tilt-Shift'],
        d: [
          'Оставляет резкой одну полосу и размывает кадр выше и ниже неё, создавая эффект миниатюры. Сплошные линии задают зону фокуса, пунктирные — плавный переход, а боковая точка поворачивает полосу.',
          'Keeps a single band sharp while blurring above and below it for a miniature-world look. The solid lines mark the focus zone, the dashed lines set the transition, and the side handle rotates the band.',
        ],
      },
      {
        t: ['Контурная резкость', 'Unsharp Mask'],
        d: [
          'Усиливает микроконтраст вдоль границ, делая снимок чётче. «Эффект» задаёт силу, «Радиус» — ширину усиливаемых контуров, а «Порог» помогает не подчёркивать мелкий шум и текстуру кожи.',
          'Sharpens details by boosting contrast along edges. Amount controls the strength, Radius sets the edge width, and Threshold keeps subtle texture like skin or grain from getting over-sharpened.',
        ],
      },
      {
        t: ['Цветовой контраст', 'High Pass'],
        d: [
          'Выделяет мелкие детали на нейтральном сером фоне. Если применить фильтр к копии слоя и перевести её в режим наложения «Перекрытие» или «Мягкий свет», получится аккуратное повышение резкости.',
          'Isolates fine detail on a neutral gray background. Run it on a duplicate layer and switch its blend mode to Overlay or Soft Light for clean, controlled sharpening.',
        ],
      },
      {
        t: ['Удаление дымки', 'Dehaze'],
        d: [
          'Возвращает контраст и насыщенность фотографиям, снятым в тумане, дымке или через стекло.',
          'Restores contrast and rich color to photos shot through haze, fog, or glass.',
        ],
      },
      {
        t: ['Шумоподавление', 'Reduce Noise'],
        d: [
          'Убирает цифровое зерно, не замыливая важные границы. Яркостный шум и цветные пятна регулируются отдельными ползунками.',
          'Cleans up digital grain while keeping edges intact, with separate sliders for luminance noise and color blotches.',
        ],
      },
      {
        t: ['Добавить шум', 'Add Noise'],
        d: [
          'Накладывает равномерное или гауссово зерно — цветное или монохромное. Пригодится для плёночной фактуры или чтобы сгладить ступеньки в плавных градиентах.',
          'Adds uniform or Gaussian grain in color or monochrome — useful for giving photos a film texture or breaking up banding in smooth gradients.',
        ],
      },
      {
        t: ['Свечение', 'Glow'],
        d: [
          'Добавляет мягкий ореол вокруг самых светлых участков кадра. Можно настроить порог, радиус и силу эффекта, а опция «Тёплое свечение» имитирует плёночную халяцию.',
          'Adds a soft halo around the brightest parts of an image using threshold, radius, and amount controls. Turn on Warm Glow to emulate analog film halation.',
        ],
      },
      {
        t: ['Хроматическая аберрация', 'Chromatic Aberration'],
        d: [
          'Сдвигает цветовые каналы ближе к краям кадра. Положительные значения добавляют художественную кайму как у старых объективов, а отрицательные помогают убрать реальные искажения на фото.',
          'Shifts color channels toward the edges of the frame. Positive values create a stylized vintage-lens fringe, while negative values help correct real lens fringing.',
        ],
      },
      {
        t: ['Тиснение', 'Emboss'],
        d: [
          'Превращает изображение в объёмный рельеф с настраиваемым углом света, высотой и силой эффекта. При желании исходные цвета можно сохранить.',
          'Gives the image a raised, sculpted relief look with adjustable light angle, height, and strength. Check Keep Colors to retain the original palette.',
        ],
      },
      {
        t: ['Выделение краёв', 'Find Edges'],
        d: [
          'Оставляет на слое только контуры объектов, превращая изображение в графичный набросок.',
          'Traces the outlines of shapes and removes flat fills, turning the image into a crisp line drawing.',
        ],
      },
      {
        t: ['Пикселизация', 'Pixelate'],
        d: [
          'Разбивает изображение на крупные цветные квадраты заданного размера — удобно, например, чтобы скрыть лицо или номер автомобиля.',
          'Breaks the image into chunky square blocks of your chosen size — handy for hiding faces, license plates, or creating a retro mosaic effect.',
        ],
      },
      {
        t: ['Полутоновый растр', 'Halftone'],
        d: [
          'Превращает картинку в сетку из точек, как при газетной печати. Можно настроить размер точки, угол сетки и выбрать чёрно-белый или цветной вариант.',
          'Converts the image into a dotted newspaper-print pattern with adjustable dot size, screen angle, and either black-and-white or color dots.',
        ],
      },
      {
        t: ['Обесцвечивание, сепия и инверсия', 'Desaturate, Sepia, and Invert'],
        d: [
          'Быстрые цветовые эффекты: перевод в чёрно-белое, тёплое тонирование под старину или негатив. Ползунок «Эффект» позволяет мягко смешать результат с исходным слоем.',
          'Quick tonal effects for black-and-white, warm vintage sepia, or a color negative. Use the Amount slider to blend the effect gently with the original layer.',
        ],
      },
      {
        t: ['Постеризация и порог', 'Posterize and Threshold'],
        d: [
          '«Постеризация» сокращает количество оттенков до заданного числа уровней яркости, а «Порог» превращает изображение в контрастное чёрно-белое по выбранной границе.',
          'Posterize reduces an image to a specific number of brightness levels for a bold graphic look, while Threshold turns every pixel pure black or white based on a brightness cutoff.',
        ],
      },
      {
        t: ['Карта градиента', 'Gradient Map'],
        d: [
          'Раскрашивает тени и света градиентом из готовых наборов или двух собственных цветов — отличный инструмент для дуотонов и цветовой стилизации.',
          'Maps shadows and highlights onto a color gradient using built-in presets or your own custom colors — ideal for duotones and creative color grading.',
        ],
      },
      {
        t: ['Цветовой LUT (.cube)', 'Color LUT (.cube)'],
        d: [
          'Загружает 3D-таблицу цветокоррекции из файла .cube — так можно применять готовые кинематографические луки и эмуляции плёнки, регулируя их силу ползунком «Эффект».',
          'Applies a 3D color lookup table from a .cube file, letting you use cinema looks and film emulations and dial in their intensity with the Amount slider.',
        ],
      },
    ],
  },
  {
    id: 'image', t: ['Изображение', 'Image'],
    items: [
      {
        t: ['Размер изображения', 'Image Size'], k: 'Ctrl+Alt+I',
        d: [
          'Изменяет разрешение документа в пикселях или процентах, с сохранением пропорций или без него. В поле «Ресамплинг» выбирается алгоритм пересчёта: режим «Автоматически» сам подбирает оптимальный вариант для уменьшения или увеличения.',
          'Resizes the entire document by pixel dimensions or percentage, with or without locked proportions. Under Resample, choose how pixels are recalculated — Automatic picks the best method depending on whether you\'re shrinking or enlarging.',
        ],
      },
      {
        t: ['Размер холста', 'Canvas Size'], k: 'Ctrl+Alt+C',
        d: [
          'Добавляет поля вокруг изображения или обрезает его без масштабирования самих пикселей. «Расположение» задаёт, от какого края расширять холст, галочка «Относительно» позволяет указать величину прибавки, а «Цвет расширения» выбирает заливку новых полей: прозрачность, фоновый, белый или чёрный цвет.',
          'Adds space around the image or trims the edges without scaling your pixels. Use Anchor to choose which direction the canvas grows, check Relative to enter the amount to add, and pick transparent, background, white, or black for the new border.',
        ],
      },
      {
        t: ['Вращение изображения', 'Image Rotation'],
        d: [
          'Поворачивает весь документ на 180°, 90° или на произвольный угол, а также отражает холст по горизонтали или вертикали. Чтобы повернуть только один слой, воспользуйтесь кнопками в параметрах инструмента «Перемещение».',
          'Rotates the entire document by 180°, 90°, or any custom angle, and flips the canvas horizontally or vertically. To rotate a single layer instead, use the buttons in the Move tool\'s options bar.',
        ],
      },
      {
        t: ['Кадрировать по выделению', 'Crop to Selection'],
        d: [
          'Обрезает весь документ ровно по границам текущего выделения.',
          'Trims the entire document tightly to the bounds of your active selection.',
        ],
      },
      {
        t: ['Внешний канал', 'Apply Image'],
        d: [
          'Накладывает на активный слой другой слой, объединённое изображение или отдельный канал (R, G, B либо прозрачность) из этого или другого открытого документа того же размера. Можно выбрать режим наложения и непрозрачность, а для «Сложения» и «Вычитания» — дополнительно задать масштаб и сдвиг.',
          'Blends another layer, the merged composite, or an individual channel (R, G, B, or transparency) from the current document or another open one of the same size onto the active layer. Choose any blend mode and opacity, plus scale and offset when using Add or Subtract.',
        ],
      },
      {
        t: ['Цветовой профиль', 'Color Profile'],
        d: [
          'Показывает текущий профиль документа и позволяет сменить его. «Преобразовать» переводит цвета в sRGB, Display P3 или Adobe RGB, сохраняя внешний вид картинки, а «Назначить» начинает трактовать те же значения пикселей в другом пространстве, из-за чего цветопередача меняется.\n\nЗдесь же можно перевести изображение в «Индексированные цвета» — свести его к палитре до 256 оттенков с опциональным дизерингом.',
          'Shows the document\'s active color profile and lets you change it. Convert translates colors into sRGB, Display P3, or Adobe RGB while keeping the image looking the same, whereas Assign reinterprets the existing pixel numbers in another color space, changing how the image looks.\n\nThis window also includes Indexed Colors, which reduces the image to a palette of up to 256 colors with optional dithering.',
        ],
      },
      {
        t: ['Показать метаданные', 'Show Metadata'],
        d: [
          'Открывает плавающее окно с информацией о файле и параметрами съёмки EXIF: моделью камеры и объектива, выдержкой, диафрагмой, ISO, датой и координатами GPS.',
          'Opens a floating panel with file details and EXIF shooting data — camera and lens model, exposure settings, focal length, date taken, and GPS coordinates.',
        ],
      },
    ],
  },
  {
    id: 'ai', t: ['ИИ-функции', 'AI features'],
    intro: [
      'Облачные ИИ-инструменты работают через ваши собственные API-ключи Stability AI и Topaz Labs (Редактирование → Настройки ИИ, Ctrl+K) и списывают кредиты вашего аккаунта. Ключи хранятся только на вашем компьютере, а изображение отправляется в сервис исключительно по вашей команде. Перед отправкой PhotoPane проверяет, подходит ли картинка под ограничения сервиса, и заранее предупреждает, если что-то не так.',
      'Cloud AI tools run on your own Stability AI and Topaz Labs API keys (Edit → AI Settings, Ctrl+K) and use credits from your account. Your keys never leave your computer, and images are only sent when you explicitly start an operation. Before uploading anything, PhotoPane checks whether the image meets the service\'s limits and lets you know right away if it doesn\'t.',
    ],
    items: [
      {
        t: ['Увеличить разрешение (ИИ)', 'Upscale (AI)'],
        d: [
          'Увеличивает изображение в 2× или 4×, бережно восстанавливая мелкие детали. Локальная модель работает полностью офлайн (после разовой загрузки около 5 МБ), увеличивает растровые слои по отдельности и сохраняет редактируемость текста.\n\nДля облачного увеличения можно выбрать Topaz Labs или Stability AI. Topaz сам подбирает подходящую модель под снимок: деликатную High Fidelity для уже резких фотографий, Standard для мягких и Low Resolution для небольших изображений. Stability AI принимает картинки размером до 1536 px по длинной стороне и до 1 Мп.',
          'Enlarges an image by 2× or 4× while reconstructing fine detail. The local model runs completely offline after a one-time 5 MB download, upscales raster layers individually, and keeps text editable.\n\nFor cloud upscaling, choose Topaz Labs or Stability AI. PhotoPane automatically selects the right Topaz model for your photo — High Fidelity for sharp shots, Standard for softer ones, and Low Resolution for small images. Stability AI accepts images up to 1536 px per side and 1 MP.',
        ],
      },
      {
        t: ['Удалить фон (ИИ)', 'Remove Background (AI)'],
        d: [
          'Определяет главный объект на слое и прячет фон с помощью маски слоя. Исходные пиксели при этом не удаляются, поэтому края всегда можно аккуратно подправить кистью по маске. Нужен API-ключ Stability AI.',
          'Detects the main subject on the active layer and hides the background using a layer mask. Because no pixels are erased, you can always refine the edges afterward with a brush on the mask. Requires a Stability AI API key.',
        ],
      },
      {
        t: ['Выделить объект (ИИ)', 'Select Subject (AI)'],
        d: [
          'Находит главный объект на снимке и сразу создаёт вокруг него выделение. Нужен API-ключ Stability AI.',
          'Finds the main subject in the image and turns it into an active selection. Requires a Stability AI API key.',
        ],
      },
      {
        t: ['Дорисовка при кадрировании', 'AI fill when cropping'],
        d: [
          'Вытяните рамку кадрирования за края снимка и выберите «Расширение: дорисовать через ИИ» — недостающие участки сгенерируются на отдельном слое поверх изображения. Чтобы сервис принял запрос, часть снимка внутри рамки не должна быть длиннее соотношения 2,5 : 1. Если нет ключа или интернета, выберите вариант «С учётом содержимого» — он работает локально.',
          'Drag the crop frame beyond the canvas edges and select Extend: Fill in with AI to generate the missing areas on a new layer above your image. The portion of the photo inside the frame must have an aspect ratio of 2.5 : 1 or less. If you\'re offline or don\'t have an API key, choose Content-Aware to fill the space locally instead.',
        ],
      },
      {
        t: ['Кредиты: остаток и расход', 'Credits: balance and spending'], k: 'Ctrl+K',
        d: [
          'В «Настройках ИИ» под каждым ключом показывается текущий остаток на аккаунте — заодно это сразу проверяет, что ключ рабочий. Ниже ведётся локальный учёт того, сколько кредитов и запросов потратил сам PhotoPane за 7 дней, 30 дней или всё время; траты других программ с тем же ключом сюда не попадают.\n\nСтоимость видна прямо там, где вы запускаете операцию: в окне увеличения разрешения, а перед удалением фона, выделением объекта и дорисовкой PhotoPane показывает окно подтверждения с названием сервиса, ценой и остатком. После каждого облачного запроса появляется уведомление о том, сколько кредитов списано и сколько осталось.',
          'In AI Settings, each API key displays your current account balance — which also confirms the key is valid. Below that, PhotoPane tracks how many credits and requests the app itself has used over the last 7 days, 30 days, or all time, counted locally without mixing in activity from other apps.\n\nYou always see the price before running an operation: right inside the Upscale dialog, and in a confirmation prompt before removing backgrounds, selecting subjects, or running generative fill — showing which service receives the image, the cost, and your balance. Once a cloud request finishes, a toast shows how many credits were spent and how many remain.',
        ],
      },
    ],
  },
  {
    id: 'file', t: ['Файл и пакетная обработка', 'File and batch processing'],
    items: [
      {
        t: ['Поместить', 'Place'],
        d: [
          'Добавляет изображение из файла новым слоем в открытый документ. Тот же результат даёт перетаскивание файла в окно редактора с зажатым Alt.',
          'Imports an image file as a new layer in your open document. You can also hold Alt while dragging a file into the window to do the same.',
        ],
      },
      {
        t: ['Пакетная обработка', 'Batch processing'],
        d: [
          'Позволяет обработать сразу целую папку или набор файлов: уменьшить их до заданного размера, применить автокоррекцию или сохранённый пресет, перевести в JPEG, PNG или WebP и при необходимости сохранить метаданные EXIF. Готовые файлы складываются в отдельную папку или заменяют оригиналы.',
          'Processes a whole folder or group of files in one go: downsize images to fit target dimensions, run Auto adjustment or apply a saved preset, convert to JPEG, PNG, or WebP, and optionally keep EXIF metadata. Results can be saved into a separate folder or overwrite the originals.',
        ],
      },
      {
        t: ['Печать', 'Print'], k: 'Ctrl+P',
        d: [
          'Отправляет текущий документ на печать через стандартный системный диалог.',
          'Sends the active document to your printer using the system print dialog.',
        ],
      },
      {
        t: ['Открывать файлы PSD в PhotoPane', 'Open PSD files in PhotoPane'],
        d: [
          'Команда из меню «Файл» в десктопной версии для Windows — регистрирует PhotoPane как программу по умолчанию для файлов .psd.',
          'Available in the File menu of the Windows desktop app — registers PhotoPane as your default editor for .psd files.',
        ],
      },
    ],
  },
];
