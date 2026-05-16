import UIKit

// LiveViewerViewController — Stage 1 scaffold (2026-05-16).
//
// Black placeholder screen for the Live viewer experience. Stage 2 will
// subscribe to the host's LiveKit Room and render the remote video track
// into a SampleBufferDisplayLayer (or LiveKit's own VideoView).

final class LiveViewerViewController: UIViewController {

  let lkToken: String
  let lkUrl: String
  let roomName: String
  let hostName: String?
  let hostAvatarUrl: String?

  init(lkToken: String,
       lkUrl: String,
       roomName: String,
       hostName: String?,
       hostAvatarUrl: String?) {
    self.lkToken = lkToken
    self.lkUrl = lkUrl
    self.roomName = roomName
    self.hostName = hostName
    self.hostAvatarUrl = hostAvatarUrl
    super.init(nibName: nil, bundle: nil)
    self.modalPresentationStyle = .fullScreen
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) not supported")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    let label = UILabel()
    label.text = "LiveViewer Stage 1 skeleton"
    label.textColor = .white
    label.font = .systemFont(ofSize: 18, weight: .semibold)
    label.textAlignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)

    let sub = UILabel()
    sub.text = hostName.map { "ao vivo: \($0)" } ?? ""
    sub.textColor = .lightGray
    sub.font = .systemFont(ofSize: 14)
    sub.textAlignment = .center
    sub.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(sub)

    let button = UIButton(type: .system)
    button.setTitle("Sair", for: .normal)
    button.setTitleColor(.white, for: .normal)
    button.backgroundColor = UIColor(red: 0.30, green: 0.30, blue: 0.32, alpha: 1.0)
    button.layer.cornerRadius = 24
    button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 32, bottom: 12, right: 32)
    button.translatesAutoresizingMaskIntoConstraints = false
    button.addTarget(self, action: #selector(onLeaveTap), for: .touchUpInside)
    view.addSubview(button)

    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -40),

      sub.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      sub.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 8),

      button.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      button.topAnchor.constraint(equalTo: sub.bottomAnchor, constant: 32),
    ])
  }

  @objc private func onLeaveTap() {
    NotificationCenter.default.post(
      name: LiveNativeNotifications.didEnd,
      object: nil,
      userInfo: ["roomName": roomName, "reason": "leave"]
    )
    dismiss(animated: true, completion: nil)
  }
}
