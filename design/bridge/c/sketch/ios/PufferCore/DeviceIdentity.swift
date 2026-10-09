import CryptoKit
import Foundation

// P-256 signing key in the Keychain (Secure Enclave on a real device; software key on the simulator, which has no SE).
// Signs the relay's nonce at connect and every registerAgent/revokeAgent frame.
// Agent secrets are generated here, shown once to the user, and only their SHA-256 is sent to the relay.

enum DeviceIdentity {
  static func publicKeyDer() throws -> Data { fatalError("not implemented") }
  static func sign(_ payload: Data) throws -> Data { fatalError("not implemented") }
}

struct AgentCredential {
  let agentId: AgentID
  let token: String            // pk_<agentId>.<secret>, returned once, never persisted on the phone
  let secretSha256: String
  static func mint() -> AgentCredential { fatalError("not implemented") }
}
